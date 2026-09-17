/**
 * `npm run triage` — 「送受信が止まった」ときの一次切り分けを1コマンドで行う診断レポート。
 *
 * 設計方針:
 *  - **読み取り専用**。稼働中のブリッジを一切邪魔しない（DB は readonly、Telegram は getUpdates を
 *    呼ばない＝ long polling と競合しない、Playwright は起動しない＝プロファイルロックを奪わない）。
 *  - 「両方向とも無反応」のとき、原因は大きく5つに分かれる。どれなのかを機械的に確定させる:
 *      (1) プロセスが死んでいる            → bridge.lock の鮮度
 *      (2) Lpro のログインが切れて待機中    → .lpro-session の鮮度 + ログの「未ログイン」
 *      (3) Telegram 側の断（401/409/権限）  → getMe / getWebhookInfo / getChat / getChatMember
 *      (4) Lpro の画面変更（セレクタ切れ）  → ログの巡回エラーの型
 *      (5) 設定の取り違え（案件・グループ）  → doctor 相当のチェック + 案件一覧
 *  - 最後に「いつから止まっているか」（DB の最終記録時刻）と「次にやること」を出す。
 */
// ★env.js を最初に import する（案件の解決と .env の読み込み）★
import { instanceId, dataDir, envPath } from './env.js';
import { cfg, inboxes } from './config.js';
import { statSync, existsSync, openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import Database from 'better-sqlite3';
import { Bot, GrammyError } from 'grammy';
import { runDoctor } from './preflight.js';
import { listInstances, isInstanceLive, lockPath, LIVE_LOCK_MAX_AGE_MS } from './instances.js';
import { pm2AppName } from './paths.js';

const problems: string[] = [];   // 止まっている直接の原因（と思われるもの）
const nextSteps: string[] = [];  // 人がやること

function h(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}`);
}
function ok(msg: string): void { console.log(`  OK   ${msg}`); }
function warn(msg: string): void { console.log(`  注意 ${msg}`); }
function bad(msg: string, step?: string): void {
  console.log(`  ❌   ${msg}`);
  problems.push(msg);
  if (step) nextSteps.push(step);
}
function info(msg: string): void { console.log(`       ${msg}`); }

/** 経過時間を日本語に（「3分前」「2時間14分前」「4日前」） */
function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}秒前`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}分前`;
  const hh = Math.floor(m / 60), mm = m % 60;
  if (hh < 48) return `${hh}時間${mm}分前`;
  return `${Math.floor(hh / 24)}日前`;
}
function stamp(ms: number): string {
  return `${new Date(ms).toLocaleString('ja-JP')}（${ago(Date.now() - ms)}）`;
}
function mtimeOf(p: string): number | null {
  try { return statSync(p).mtimeMs; } catch { return null; }
}

// ───────────────────────────────────────────────────────── 1. 案件と設定
function sectionConfig(): void {
  h('1. 案件と設定');
  const label = cfg.instanceLabel || '既定';
  info(`案件: ${label}${instanceId ? ` (id=${instanceId})` : '（ルート配置）'} / PM2アプリ名: ${pm2AppName(instanceId)}`);
  info(`設定: ${envPath}`);
  info(`データ: ${dataDir}`);
  info(`受信箱: ${inboxes.length ? inboxes.map((i) => `${i.name}→${i.groupChatId}`).join(' / ') : '（有効な受信箱がありません）'}`);
  info(`MIRROR_SELF=${cfg.selfMode} / ONLY_UNREAD=${cfg.onlyUnread} / HEADLESS=${cfg.headless} / 巡回間隔=${cfg.pollIntervalMs}ms`);

  const d = runDoctor();
  for (const p of d.problems) bad(`設定: ${p}`, '`.env` を修正して `npm run doctor` が通る状態にする');
  for (const w of d.warnings) warn(`設定: ${w}`);
  if (d.problems.length === 0) ok('設定チェック（doctor）に致命的な問題はありません');

  // 他案件（同じPCで複数のLproアカウントを回している場合、別案件を見ていた事故の切り分け）
  const others = listInstances().filter((i) => i.id !== instanceId);
  if (others.length > 0) {
    info(`他の案件: ${others.map((o) => `${o.id || '既定'}(${isInstanceLive(o) ? '稼働中' : '停止'})`).join(' / ')}`);
  }
}

// ───────────────────────────────────────────────────────── 2. プロセスの生存
/** bridge.lock は稼働中プロセスが30秒ごとに touch する。鮮度＝プロセスが生きているか */
function sectionProcess(): { live: boolean; lastAlive: number | null } {
  h('2. ブリッジ プロセスの生存');
  const lp = lockPath(dataDir);
  const m = mtimeOf(lp);
  if (m === null) {
    bad(
      'ブリッジのプロセスが動いていません（bridge.lock が無い＝正常終了して以降、起動していない）',
      `\`pm2 start ecosystem.config.cjs --only ${pm2AppName(instanceId)}\` で起動する（起動しない/落ち続けるなら下の「PM2 ログ」を確認）`
    );
    return { live: false, lastAlive: null };
  }
  const age = Date.now() - m;
  if (age < LIVE_LOCK_MAX_AGE_MS) {
    ok(`プロセスは稼働中（最終生存: ${stamp(m)}）`);
    return { live: true, lastAlive: m };
  }
  bad(
    `ブリッジのプロセスが止まっています（最後に生きていたのは ${stamp(m)}）`,
    `\`pm2 list\` で状態を確認し、\`pm2 restart ${pm2AppName(instanceId)}\`（止まっていれば \`pm2 start ecosystem.config.cjs --only ${pm2AppName(instanceId)}\`）で再開する`
  );
  return { live: false, lastAlive: m };
}

// ───────────────────────────────────────────────────────── 3. Lpro ログイン
/** .lpro-session は「ログイン確認OK」のたびに書き直される＝最後にログインが取れていた時刻の目安 */
function sectionLpro(live: boolean): void {
  h('3. Lpro のログイン状態');
  if (!existsSync(cfg.userDataDir)) {
    bad(`ブラウザプロファイルがありません: ${cfg.userDataDir}`, '`npm run login` で初回ログインをやり直す');
  } else {
    ok(`ブラウザプロファイル: ${cfg.userDataDir}`);
  }
  const m = mtimeOf(cfg.sessionFile);
  if (m === null) {
    warn(`ログインCookieの退避ファイルがありません（${cfg.sessionFile}）。まだ一度もログイン確認OKになっていない可能性`);
  } else {
    const age = Date.now() - m;
    // 退避は「内容が変わったときだけ」書くため、鮮度は目安。1日以上更新が無いのは疑わしい
    if (live && age > 24 * 60 * 60 * 1000) {
      warn(`ログインCookieの退避が古いです（最終: ${stamp(m)}）。ログイン待ちで止まっている可能性があります`);
    } else {
      ok(`ログインCookieの退避: ${stamp(m)}`);
    }
  }
  info('※ ログイン切れは「プロセスは生きたまま巡回だけ止まる」状態です。復旧は画面のブラウザで人が');
  info('   ログインし直すしかありません（pm2 restart では直りません。RUNBOOK C章）。');
}

// ───────────────────────────────────────────────────────── 4. Telegram 疎通
async function sectionTelegram(): Promise<void> {
  h('4. Telegram の疎通と権限');
  // 稼働中の long polling と競合しない API だけを使う（getUpdates は絶対に呼ばない）
  const bot = new Bot(cfg.telegramToken);
  let botId = 0;
  try {
    const me = await bot.api.getMe();
    botId = me.id;
    ok(`Bot トークン有効: @${me.username} (id=${me.id})`);
  } catch (e) {
    if (e instanceof GrammyError && e.error_code === 401) {
      bad(
        'Bot トークンが無効です（401）。BotFather でトークンが再生成された／取り消された可能性',
        'BotFather で `/mytoken`（または `/revoke`→再取得）を確認し、`.env` の TELEGRAM_BOT_TOKEN を更新して再起動する'
      );
    } else {
      bad(`Telegram API に到達できません: ${String(e).slice(0, 200)}`, 'PC のネットワーク／プロキシ／ファイアウォールを確認する');
    }
    return; // トークンが使えないなら以降のチェックは無意味
  }

  // Webhook が設定されていると long polling（getUpdates）は 409 で回らない＝Telegram→Lpro が無反応になる
  try {
    const wh = await bot.api.getWebhookInfo();
    if (wh.url) {
      bad(
        `この Bot に Webhook が設定されています（${wh.url}）。long polling が動かず Telegram からの返信を受け取れません`,
        'Webhook を解除する（ブラウザで `https://api.telegram.org/bot<トークン>/deleteWebhook` を開く）'
      );
    } else {
      ok('Webhook 未設定（long polling で正常）');
      if (wh.pending_update_count > 0) {
        // 誰も getUpdates していない＝本体が受信できていない状態でたまる
        warn(`未受信の更新が ${wh.pending_update_count} 件たまっています（＝ブリッジが Telegram を読めていない時間がある）`);
      }
    }
  } catch (e) {
    warn(`getWebhookInfo 失敗: ${String(e).slice(0, 120)}`);
  }

  // 受信箱ごとのグループ: 存在・フォーラム(Topics)・bot が管理者でトピック管理権限を持つか
  for (const ib of inboxes) {
    try {
      const chat = await bot.api.getChat(ib.groupChatId);
      const title = 'title' in chat ? chat.title : '(不明)';
      const isForum = 'is_forum' in chat ? chat.is_forum === true : false;
      if (!isForum) {
        bad(
          `[${ib.name}] グループ「${title}」で Topics が OFF です（トピックを作れません）`,
          `Telegram のグループ設定で「トピック(Topics)」を ON にする（${ib.name}）`
        );
      } else {
        ok(`[${ib.name}] グループ「${title}」(${ib.groupChatId}) / Topics ON`);
      }
      const mem = await bot.api.getChatMember(ib.groupChatId, botId);
      if (mem.status !== 'administrator') {
        bad(
          `[${ib.name}] Bot がグループの管理者ではありません（status=${mem.status}）`,
          `Bot をグループの管理者にし、「トピックの管理(Manage Topics)」権限を付ける（${ib.name}）`
        );
      } else if (!mem.can_manage_topics) {
        bad(
          `[${ib.name}] Bot に「トピックの管理(Manage Topics)」権限がありません`,
          `Bot の管理者権限に「トピックの管理(Manage Topics)」を追加する（${ib.name}）`
        );
      } else {
        ok(`[${ib.name}] Bot は管理者＋トピック管理権限あり`);
      }
    } catch (e) {
      const desc = e instanceof GrammyError ? `${e.error_code} ${e.description}` : String(e).slice(0, 160);
      bad(
        `[${ib.name}] グループ(${ib.groupChatId})にアクセスできません: ${desc}`,
        `Bot がそのグループから退出させられていないか／グループIDが正しいかを確認する（\`npm run chatid\` は本体停止中に実行）`
      );
    }
  }
}

// ───────────────────────────────────────────────────────── 5. DB（いつから止まっているか）
type DbRow = { n: number; last: number | null };
function sectionDb(): void {
  h('5. 台帳（いつから記録が止まっているか）');
  if (!existsSync(cfg.dbPath)) {
    bad(`DB がありません: ${cfg.dbPath}`, 'DB の場所（DB_PATH / 案件）が正しいか確認する');
    return;
  }
  let db: Database.Database;
  try {
    // 稼働中でも安全なように readonly。WAL の共有メモリが無い（完全停止中）と失敗するので読み書きで開き直す
    db = new Database(cfg.dbPath, { readonly: true, fileMustExist: true });
  } catch {
    try {
      db = new Database(cfg.dbPath, { fileMustExist: true });
    } catch (e) {
      bad(`DB を開けません: ${String(e).slice(0, 160)}`);
      return;
    }
  }
  try {
    const all = db.prepare('SELECT COUNT(*) n, MAX(created_at) last FROM seen_messages').get() as DbRow;
    if (!all.last) {
      warn('メッセージの記録が1件もありません（まだ一度も巡回できていない可能性）');
    } else {
      const age = Date.now() - all.last;
      const line = `最後にメッセージを記録した時刻: ${stamp(all.last)}（台帳 ${all.n} 件）`;
      // 巡回できていれば、顧客が来なくても自分側（配信・自動応答）の記録で日常的に更新される
      if (age > 6 * 60 * 60 * 1000) bad(`${line} ＝ これ以降、Lpro から何も取り込めていません`);
      else ok(line);
    }
    for (const ib of inboxes) {
      const r = db.prepare(
        'SELECT COUNT(*) n, MAX(created_at) last FROM seen_messages WHERE customer_key LIKE ?'
      ).get(`${ib.id}:%`) as DbRow;
      info(`[${ib.name}] 台帳 ${r.n} 件 / 最終記録: ${r.last ? stamp(r.last) : 'なし'}`);
    }
    const cust = db.prepare(
      'SELECT COUNT(*) n, MAX(last_activity) last FROM customers'
    ).get() as DbRow;
    const topics = db.prepare('SELECT COUNT(*) n FROM customers WHERE topic_thread_id IS NOT NULL').get() as { n: number };
    info(`顧客 ${cust.n} 件 / トピック作成済み ${topics.n} 件 / 最終活動: ${cust.last ? stamp(cust.last) : 'なし'}`);

    const pend = db.prepare('SELECT COUNT(*) n, MAX(created_at) last FROM pending_replies').get() as DbRow;
    if (pend.n > 0) {
      // 「送信中に落ちた返信」の控え。残っている＝Lpro に届いていない可能性のある返信がある
      bad(
        `未送信の可能性がある返信が ${pend.n} 件、控えに残っています（最新: ${pend.last ? stamp(pend.last) : '不明'}）`,
        'Lpro 側でその返信が送信済みか確認し、未送信なら送り直す'
      );
    } else {
      ok('送信待ちの控えは空（送信途中で落ちた返信は無し）');
    }
  } finally {
    db.close();
  }
}

// ───────────────────────────────────────────────────────── 6. PM2 ログ
const LOG_PATTERNS: { re: RegExp; label: string; step?: string }[] = [
  { re: /未ログイン|ログイン待ち|手動ログイン/, label: 'Lpro が未ログイン（ログイン待ちで巡回停止）', step: '画面に出ているブラウザで Lpro にログインし直す（RUNBOOK C章。pm2 restart では直りません）' },
  { re: /別のアカウント|site_id/, label: 'Lpro に別アカウントでログインされている（LPRO_SITE_ID 不一致）', step: 'この案件の Lpro アカウントでログインし直す' },
  { re: /409|Conflict/, label: 'Telegram 409 Conflict（同じ Bot トークンで二重起動）', step: '`npm run chatid` や別の `npm start` / 二重の PM2 プロセスが動いていないか確認する（`pm2 list`）' },
  { re: /401|Unauthorized/, label: 'Telegram 401（トークン失効）', step: 'BotFather でトークンを確認し `.env` を更新する' },
  { re: /chatframe|トーク画面.*見つかりません/, label: 'トーク画面(chatframe)が見つからない（画面構成の変化 or 未ログイン）', step: 'RUNBOOK A章（SELECTORS の確認）。未ログインが原因のこともあるので先に3章を見る' },
  { re: /検索フォーム.*現れません/, label: '検索フォームが出ない（Lpro 側の一過性エラー or 画面変更）' },
  { re: /行が1件もありません|一覧が空/, label: '顧客一覧が空で返る（Lpro 側の一過性エラー or セレクタ切れ）' },
  { re: /送信を確認できません|送信失敗/, label: '返信の送信が確認できない', step: 'Lpro 側で実際に送信されているか確認する（RUNBOOK A章 replyInput/sendButton）' },
  { re: /巡回が\d+回連続で失敗|配信失敗が\d+巡回連続/, label: '巡回/配信の連続失敗', step: 'RUNBOOK A章（セレクタ）と C章（ログイン）を確認する' },
  { re: /ECONNRESET|ENOTFOUND|ETIMEDOUT|network/i, label: 'ネットワーク断', step: 'PC のネット接続を確認する' },
];

/** ファイル末尾から最大 maxBytes を読む（巨大ログでも安全） */
function tailFile(path: string, maxBytes = 256 * 1024): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* ignore */ }
  }
}

function sectionLogs(): void {
  h('6. PM2 ログの直近の異常');
  const pm2Home = process.env.PM2_HOME ?? join(homedir(), '.pm2');
  const app = pm2AppName(instanceId);
  let found = false;
  for (const kind of ['out', 'error'] as const) {
    const p = join(pm2Home, 'logs', `${app}-${kind}.log`);
    const m = mtimeOf(p);
    if (m === null) continue;
    found = true;
    const text = tailFile(p);
    const lines = (text ?? '').split(/\r?\n/).filter((l) => l.trim() !== '');
    info(`${p}`);
    info(`  最終更新: ${stamp(m)} / 末尾 ${lines.length} 行を確認`);
    const last = lines[lines.length - 1];
    if (last) info(`  最後の行: ${last.slice(0, 200)}`);

    const hits = new Map<string, number>();
    for (const l of lines) {
      for (const pat of LOG_PATTERNS) {
        if (pat.re.test(l)) hits.set(pat.label, (hits.get(pat.label) ?? 0) + 1);
      }
    }
    for (const [label, count] of hits) {
      const pat = LOG_PATTERNS.find((x) => x.label === label);
      warn(`[${kind}] ${label}（直近ログに ${count} 回）`);
      if (pat?.step && !nextSteps.includes(pat.step)) nextSteps.push(pat.step);
    }
    // ⚠️/🚫 の自己申告は最後の数件をそのまま見せる（文面に対処が書いてある）
    const alerts = lines.filter((l) => /⚠️|🚫/.test(l)).slice(-5);
    for (const a of alerts) info(`  ⚠ ${a.slice(0, 220)}`);
  }
  if (!found) {
    warn(`PM2 のログが見つかりません（${join(pm2Home, 'logs', `${app}-out.log`)}）。PM2 で起動していない可能性があります`);
    if (!nextSteps.some((s) => s.includes('pm2 start'))) {
      nextSteps.push(`\`pm2 list\` で ${app} が登録されているか確認する（無ければ \`pm2 start ecosystem.config.cjs --only ${app}\`）`);
    }
  }
}

// ───────────────────────────────────────────────────────── 総括
function summary(): void {
  h('総括');
  if (problems.length === 0) {
    console.log('  致命的な問題は見つかりませんでした。');
    console.log('  それでも送受信が止まっている場合は、上の「5. 台帳」の最終記録時刻と');
    console.log('  「6. PM2 ログ」の末尾を添えて相談してください。');
  } else {
    console.log(`  見つかった問題 ${problems.length} 件:`);
    for (const p of problems) console.log(`   ・${p}`);
  }
  if (nextSteps.length > 0) {
    console.log('\n  次にやること:');
    nextSteps.forEach((s, i) => console.log(`   ${i + 1}. ${s}`));
  }
  console.log('');
}

async function main(): Promise<void> {
  console.log('Lpro ⇄ Telegram ブリッジ 診断（読み取りのみ・稼働中でも安全）');
  sectionConfig();
  const { live } = sectionProcess();
  sectionLpro(live);
  await sectionTelegram();
  sectionDb();
  sectionLogs();
  summary();
}

main().catch((e) => {
  console.error('\n診断中にエラー:', e);
  process.exit(1);
});
