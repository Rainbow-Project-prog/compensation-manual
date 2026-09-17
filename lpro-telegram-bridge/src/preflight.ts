/**
 * 起動前チェックの本体。doctor.ts（CLI）と index.ts（起動時ガード。PM2 は npm を
 * 経由しないため prestart が走らず、ここで再チェックする）から使う。
 */
// ★env.js を最初に import する（案件の解決と .env の読み込み）★
import { instanceId, dataDir, envPath } from './env.js';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { describeInstance, listInstances, findInstanceConflicts, findInstanceWarnings, samePath, isInstanceLive } from './instances.js';
import { pm2AppName } from './paths.js';

const REQUIRED_ENV = [
  'TELEGRAM_BOT_TOKEN',
  'LPRO_LOGIN_URL',
] as const;

// 各受信箱は「URL と グループID の両方」が揃って有効。少なくとも1つは必要
const INBOX_ENV = [
  { name: 'チャット応対', url: 'CHAT_TALK_URL', group: 'CHAT_GROUP_CHAT_ID' },
  { name: 'ダイレクトトーク応対', url: 'TALK_TALK_URL', group: 'TALK_GROUP_CHAT_ID' },
] as const;

export type PreflightResult = { problems: string[]; warnings: string[]; notes: string[] };

export function runDoctor(): PreflightResult {
  const problems: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];

  // どの案件として動いているか（複数案件運用で「別案件の .env を見ていた」を一目で分かるように）
  const label = (process.env.INSTANCE_LABEL ?? '').trim() || instanceId || '既定';
  notes.push(`案件: ${label}${instanceId ? ` (id=${instanceId})` : '（ルート配置）'} / 設定: ${envPath} / データ: ${dataDir}`);

  // 0) Node バージョン（PM2 の `node --import tsx` 起動には 20.6+ が必要）
  const [maj = 0, min = 0] = process.versions.node.split('.').map(Number);
  if (maj < 20 || (maj === 20 && min < 6)) {
    problems.push(`Node ${process.versions.node} は古すぎます（20.6 以上が必要）`);
  }

  // 1) .env の存在（通常は env.ts が先に検知して止めるが、DOTENV_CONFIG_PATH 指定等の保険）
  if (!existsSync(envPath)) {
    problems.push(`設定ファイルが見つかりません: ${envPath}（.env.example をコピーして作成してください）`);
  }

  // 2) 必須環境変数
  for (const k of REQUIRED_ENV) {
    const v = process.env[k];
    if (!v || v.trim() === '' || v.includes('（')) {
      problems.push(`環境変数 ${k} が未設定/プレースホルダのままです`);
    }
  }
  // 受信箱の設定: 少なくとも1つは URL+グループID が揃っていること。
  // 片方だけ設定されている（URL有・グループ無 など）は設定ミスとして弾く
  let enabledInboxes = 0;
  let anyTalkUnderManage = false;
  for (const ib of INBOX_ENV) {
    const url = (process.env[ib.url] ?? '').trim();
    const grp = (process.env[ib.group] ?? '').trim();
    if (url && grp) {
      enabledInboxes++;
      if (/\/manage(\/|$|\?)/.test(url)) anyTalkUnderManage = true;
      if (Number.isNaN(Number(grp)) || Number(grp) === 0) {
        problems.push(`${ib.group} が数値ではありません（npm run chatid で取得した -100... を入れる）: ${grp}`);
      }
    } else if (url || grp) {
      problems.push(`${ib.name} の設定が片方だけです（${ib.url} と ${ib.group} は両方必要、または両方空）`);
    }
  }
  if (enabledInboxes === 0) {
    problems.push('有効な受信箱がありません（CHAT_TALK_URL+CHAT_GROUP_CHAT_ID か TALK_TALK_URL+TALK_GROUP_CHAT_ID の少なくとも一方を設定）');
  }

  // Lpro の /manage はベーシック認証で保護されているため、認証情報が無いと起動できない。
  // 認証は Cookie と違いプロファイルに永続しないため、環境変数からの供給が必須
  if (anyTalkUnderManage && !process.env.LPRO_BASIC_USER) {
    problems.push('LPRO_BASIC_USER / LPRO_BASIC_PASS が未設定です（/manage は HTTP ベーシック認証で保護されています）');
  }

  // 他案件との資源競合（同じ Bot トークン / グループ / プロファイル / DB）。どれも 409 ループや
  // 別案件の顧客への誤送信に直結する（instances.ts 参照）。効き方は非対称:
  //  - 追加案件（instances/<名前>）は起動を拒否する
  //  - 既定案件（ルート .env＝本番）は、相手が「いま稼働中」（bridge.lock が新しい）なら拒否、
  //    止まっている/作りかけの相手なら警告＋Telegram 通知で稼働継続。作りかけ・コピーしただけの
  //    instances/<名前>/.env が本番の再起動を無音で殺す方が害が大きい一方、稼働中の相手と同じ Bot で
  //    起動すると 409 の交互クラッシュと別案件への誤送信になるため
  try {
    const me = describeInstance(instanceId, dataDir, envPath, process.env);
    // 自分自身はデータディレクトリの同一性で除く（--instance=Foo と フォルダ foo のような大文字小文字違いで
    // 自分と競合したことにならないように）
    const others = listInstances().filter((i) => !samePath(i.dir, dataDir));
    if (others.length > 0) notes.push(`他の案件: ${others.map((o) => o.id || '既定').join(', ')}`);
    for (const o of others) {
      const conflicts = findInstanceConflicts(me, [o]);
      if (conflicts.length === 0) continue;
      if (instanceId !== '') problems.push(...conflicts);
      else if (isInstanceLive(o)) problems.push(...conflicts.map((c) => `【稼働中の案件と競合】${c}`));
      else warnings.push(...conflicts.map((c) => `【既定案件は稼働継続・相手は停止中】${c}`));
    }
    warnings.push(...findInstanceWarnings(me, others));
  } catch (e) {
    warnings.push(`案件間の競合チェックに失敗しました（続行）: ${String(e).slice(0, 120)}`);
  }

  // PM2 配下では「アプリ名 ⇔ 案件」の対応を照合する。PM2 は起動時にシェルの環境変数を丸ごと取り込むため、
  // シェルに BRIDGE_INSTANCE が残っていると既定案件のアプリが別案件として立ち上がり（同じ Bot で 409 の
  // 交互クラッシュ＋既定案件が無巡回）、案件間チェックでは検出できない（自分＝その案件になるため）
  if (process.env.pm_id !== undefined && process.env.name) {
    const expected = pm2AppName(instanceId);
    if (process.env.name !== expected) {
      problems.push(
        `PM2 アプリ名 "${process.env.name}" と案件 "${instanceId || '既定'}"（期待アプリ名 ${expected}）が一致しません。` +
        'シェルの環境変数 BRIDGE_INSTANCE が PM2 に取り込まれた疑いがあります（BRIDGE_INSTANCE を unset した新しいシェルから pm2 を操作してください）'
      );
    }
  }

  // LPRO_SITE_ID は数値（menu iframe の URL の site_id）。タイプミスは「常に別アカウント扱い」＝ログイン待ちの永久ループになる
  {
    const raw = (process.env.LPRO_SITE_ID ?? '').trim();
    if (raw !== '' && !/^\d+$/.test(raw)) problems.push(`環境変数 LPRO_SITE_ID は数値で指定してください: "${raw}"`);
    else if (/^0\d/.test(raw)) warnings.push(`環境変数 LPRO_SITE_ID の先頭ゼロは無視して比較します: "${raw}"`);
    const lu = (process.env.LPRO_LOGIN_URL ?? '').trim();
    if (lu && !/\/manage\/?$/.test(lu)) warnings.push(`LPRO_LOGIN_URL は通常 https://<ホスト>/manage/ です（現在: ${lu}）。別アカウント検出時のログアウト URL はこの値から作られます`);
  }

  // 自動ログイン（AUTO_LOGIN / LPRO_LOGIN_ID / LPRO_LOGIN_PASSKEY）。片方だけ・プレースホルダのままを検出
  {
    const mode = (process.env.AUTO_LOGIN ?? '').trim().toLowerCase();
    const off = ['off', 'false', '0', 'no'].includes(mode);
    if (mode !== '' && !off && !['auto', 'on', 'true', '1', 'yes'].includes(mode)) {
      warnings.push(`環境変数 AUTO_LOGIN が不明な値です: "${mode}"（auto / off）→ auto として扱います`);
    }
    const id = (process.env.LPRO_LOGIN_ID ?? '').trim();
    const pk = process.env.LPRO_LOGIN_PASSKEY ?? '';
    if (/^（/.test(id) || /^（/.test(pk)) {
      problems.push('LPRO_LOGIN_ID / LPRO_LOGIN_PASSKEY がプレースホルダのままです（使わないなら両方空にする）');
    } else if (pk && !off && !(process.env.LPRO_SITE_ID ?? '').trim()) {
      // 自動ログインは無人で資格情報を送る。別案件のアカウントに入ってしまう事故を止める唯一の照合が LPRO_SITE_ID
      problems.push(
        'LPRO_LOGIN_PASSKEY を設定するときは LPRO_SITE_ID も必須です（自動ログインが別案件のアカウントに入ったときに止める照合。' +
        '値は初回ログイン後のログ「Lpro サイト確認: site_id=NN」の NN）'
      );
    } else if (id && !pk) {
      warnings.push('LPRO_LOGIN_ID だけ設定されています（LPRO_LOGIN_PASSKEY が無いと自動ログインはフォームに入力しません）');
    } else if (!id && pk) {
      warnings.push('LPRO_LOGIN_PASSKEY だけ設定されています（ID 欄が空のログイン画面では自動ログインできません。LPRO_LOGIN_ID も設定してください）');
    }
    // dotenv は引用符なしの値の '#' 以降をコメントとして捨てる。パスキーに '#' があると黙って短くなり、ロック寸前まで誤送信する
    try {
      const raw = readFileSync(envPath, 'utf8');
      const m = /^\s*LPRO_LOGIN_PASSKEY\s*=\s*(.*)$/m.exec(raw);
      const rawVal = (m?.[1] ?? '').trim();
      if (rawVal && !/^["'`]/.test(rawVal) && rawVal.includes('#')) {
        warnings.push('LPRO_LOGIN_PASSKEY に引用符なしの # が含まれています（# 以降は無視されます）。値全体を "…" で囲んでください');
      }
    } catch { /* .env が無い場合は上で検出済み */ }
    if (off) notes.push('自動ログイン: 無効（AUTO_LOGIN=off。セッション失効時は手動ログイン待ち）');
    else if (pk) notes.push('自動ログイン: 有効（.env の ID/パスキーで入力・送信）');
    else {
      notes.push('自動ログイン: 資格情報なし（ブラウザが自動入力済みのフォームを送信するだけ。無人復旧には LPRO_LOGIN_ID / LPRO_LOGIN_PASSKEY を設定）');
      if (!(process.env.LPRO_SITE_ID ?? '').trim()) {
        warnings.push('LPRO_SITE_ID が未設定です。ブラウザの自動入力で別アカウントに入っても検出できません（設定を推奨）');
      }
    }
  }

  // 数値系はタイプミス（NaN）が「初回メッセージの無音喪失」「ウェイトなし巡回」に直結するため事前に弾く
  for (const k of ['POLL_INTERVAL_MS', 'BOOTSTRAP_TAIL'] as const) {
    const raw = process.env[k];
    if (raw !== undefined && raw.trim() !== '' && !Number.isFinite(Number(raw))) {
      problems.push(`環境変数 ${k} が数値ではありません: ${raw}`);
    }
  }

  // better-sqlite3 のネイティブバイナリが現在の Node で動くこと
  // （Node のメジャー更新や npm ci の失敗で ABI 不一致になると起動時に落ちる）
  try {
    const require_ = createRequire(import.meta.url);
    const Database = require_('better-sqlite3');
    new Database(':memory:').close();
  } catch (e) {
    problems.push(
      `better-sqlite3 が現在の Node (${process.versions.node}) で動きません` +
      `（npm ci のやり直しが必要）: ${String(e).slice(0, 120)}`
    );
  }

  // 3) SELECTORS の 'TODO' 残り
  const configPath = fileURLToPath(new URL('./config.ts', import.meta.url));
  const configSrc = readFileSync(configPath, 'utf8');
  const todoSelectors = [...configSrc.matchAll(/(\w+):\s*'TODO'/g)].map((m) => m[1]);
  if (todoSelectors.length > 0) {
    problems.push(`SELECTORS が未確定です（'TODO' のまま）: ${todoSelectors.join(', ')}`);
  }

  // 4) lpro-adapter の未実装 TODO コメント（参考警告のみ）
  // ※ SELECTORS 確定後も残る `=== 'TODO'` センチネル比較を数えないよう、コメントの TODO だけ数える
  const adapterPath = fileURLToPath(new URL('./lpro-adapter.ts', import.meta.url));
  const adapterSrc = readFileSync(adapterPath, 'utf8');
  const todoCount = (adapterSrc.match(/\/\/\s*TODO|\/\*\s*TODO/g) ?? []).length;
  if (todoCount > 0) {
    warnings.push(`lpro-adapter.ts に未実装の TODO コメントが ${todoCount} 件あります（送信検証・会話の開き方を確認）`);
  }

  return { problems, warnings, notes };
}

export function printResult(r: PreflightResult): void {
  console.log('=== Lpro ⇄ Telegram bridge doctor ===');
  for (const n of r.notes) console.log('  ' + n);
  if (r.warnings.length) {
    console.log('\n[warn]');
    for (const w of r.warnings) console.log('  - ' + w);
  }
  if (r.problems.length) {
    console.log('\n[NG] 起動前に解決が必要:');
    for (const p of r.problems) console.log('  ✗ ' + p);
    console.log('\n→ 解決後にもう一度 `npm run doctor` を実行してください。');
    return;
  }
  console.log('\n[OK] 必須項目はすべて揃っています。`npm start` で起動できます。');
}
