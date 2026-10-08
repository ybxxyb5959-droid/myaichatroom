import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);
const PORT = 8443;

// A private connection never becomes public implicitly. Both modes own only
// their exact proxy target and refuse an existing mapping.
export function startTailscaleServe(target, options = {}) {
  return startProxy(target, options, false);
}
export function startTailscaleFunnel(target, options = {}) {
  return startProxy(target, options, true);
}
async function startProxy(target, { execute = executeFile, platform = process.platform, env = process.env, port = PORT } = {}, publicAccess) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || (publicAccess && port !== PORT)) throw new Error('공유 포트를 확인하세요.');
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(target)) throw new Error('휴대폰 연결 대상은 로컬 서버여야 합니다.');
  const bin = platform === 'win32' ? path.join(env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe') : 'tailscale';
  const call = async (args) => {
    try { return await execute(bin, args, { windowsHide: true, timeout: 30000, maxBuffer: 128 * 1024 }); }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error('먼저 PC에 Tailscale을 설치하고 로그인해 주세요. https://tailscale.com/download');
      const approval = `${error.stdout || ''}\n${error.stderr || ''}`.match(/https:\/\/login\.tailscale\.com\/[^\s<>"']+/)?.[0];
      throw new Error(`Tailscale ${publicAccess ? 'Funnel' : 'Serve'} 연결을 완료하지 못했습니다. ${approval ? `계정 승인 필요: ${approval}` : '로그인과 HTTPS/Funnel 허용 상태를 확인하세요. https://login.tailscale.com/admin/dns'}`);
    }
  };
  const status = JSON.parse((await call(['status', '--json'])).stdout);
  const dns = status.Self?.DNSName?.replace(/\.$/, '');
  if (status.BackendState !== 'Running' || !dns || !/^[a-z0-9.-]+\.ts\.net$/i.test(dns))
    throw new Error('Tailscale 연결과 MagicDNS를 켠 뒤 다시 시도해 주세요.');
  const endpoint = `${dns}:${port}`, url = `https://${endpoint}`;
  const configuration = async () => JSON.parse((await call(['serve', 'status', '--json'])).stdout || '{}');
  const before = await configuration();
  if (before.TCP?.[port] || before.Web?.[endpoint] || before.AllowFunnel?.[endpoint])
    throw new Error('Tailscale 8443 포트를 다른 연결이 사용 중입니다. 기존 연결을 확인해 주세요. 자동으로 덮어쓰지 않습니다.');
  const command = publicAccess ? 'funnel' : 'serve';
  const matches = (config) => config.TCP?.[port]?.HTTPS === true
    && config.Web?.[endpoint]?.Handlers?.['/']?.Proxy === target && !!config.AllowFunnel?.[endpoint] === publicAccess;
  const stop = async () => {
    const current = await configuration();
    if (current.Web?.[endpoint]?.Handlers?.['/']?.Proxy === target) await call([command, `--https=${port}`, 'off']);
  };
  try {
    await call([command, '--bg', `--https=${port}`, target]);
    if (!matches(await configuration())) throw new Error(`Tailscale ${command} HTTPS 주소와 공개 여부를 확인하지 못했습니다. 계정의 사용 권한을 확인하세요.`);
  } catch (error) {
    try { await stop(); } catch (cleanup) { throw new Error(`${error.message}\n연결 해제도 실패했습니다: ${cleanup.message}`); }
    throw error;
  }
  return { url, stop, public: publicAccess };
}
