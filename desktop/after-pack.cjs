const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
module.exports = async context => {
  if (context.electronPlatformName !== 'win32') return;
  const executable = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  const editor = path.join(context.packager.projectDir, 'node_modules/electron-winstaller/vendor/rcedit.exe');
  const temporary = path.join(context.appOutDir, 'icon-edit-temporary.exe');
  fs.copyFileSync(executable, temporary);
  try {
    execFileSync(editor, [temporary, '--set-icon', path.join(context.packager.projectDir,'public/app.ico'), '--set-version-string','ProductName','AI 단톡방','--set-version-string','FileDescription','AI 단톡방'], {windowsHide:true});
    fs.copyFileSync(temporary, executable);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
};
