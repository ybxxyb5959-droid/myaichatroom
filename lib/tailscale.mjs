import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isIP } from 'node:net';

const run = promisify(execFile);

export async function getTailscaleAddress({ execute = run, platform = process.platform, env = process.env } = {}) {
  const bin = platform === 'win32'
    ? path.join(env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe')
    : 'tailscale';
  let result;
  try {
    result = await execute(bin, ['ip', '-4'], { windowsHide: true, timeout: 10000, maxBuffer: 16384 });
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('PC에 Tailscale을 설치하고 휴대폰과 같은 계정으로 로그인한 뒤 다시 눌러 주세요. https://tailscale.com/download');
    throw new Error('Tailscale 주소를 가져오지 못했습니다. PC의 Tailscale을 켜고 로그인 상태를 확인해 주세요.');
  }
  const address = result.stdout.trim();
  const [first, second] = address.split('.').map(Number);
  if (isIP(address) !== 4 || first !== 100 || second < 64 || second > 127)
    throw new Error('Tailscale 전용 IPv4 주소가 없습니다. Tailscale 연결을 켠 뒤 다시 눌러 주세요.');
  return address;
}
