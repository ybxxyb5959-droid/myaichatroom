$ErrorActionPreference = 'Stop'
# Uses an installed toolchain; does not install or publish anything.
$androidSdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } elseif ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
if (!(Test-Path -LiteralPath (Join-Path $androidSdk 'platforms\android-36\android.jar'))) { throw 'Android API 36 SDK required. APK was not generated.' }
$androidJava = if ($env:JAVA_HOME) { Join-Path $env:JAVA_HOME 'bin\java.exe' } else { (Get-Command java -ErrorAction SilentlyContinue).Source }
if (!$androidJava -or !(Test-Path -LiteralPath $androidJava)) { throw 'JDK 17+ required. Set JAVA_HOME. APK was not generated.' }
$androidGradle = (Get-Command gradle -ErrorAction SilentlyContinue).Source
if (!$androidGradle) {
    $androidGradle = Get-ChildItem -LiteralPath (Join-Path $env:USERPROFILE '.gradle\wrapper\dists') -Filter gradle.bat -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match 'gradle-8\.14\.3' } | Select-Object -First 1 -ExpandProperty FullName
}
if (!$androidGradle) { throw 'Gradle 8.13+ required. APK was not generated.' }
$env:ANDROID_HOME = $androidSdk
& $androidGradle -p $PSScriptRoot --offline --no-daemon assembleDebug
if ($LASTEXITCODE -ne 0) { throw 'Android build failed. APK completion is unconfirmed.' }
Write-Output (Join-Path $PSScriptRoot 'app\build\outputs\apk\debug\app-debug.apk')
