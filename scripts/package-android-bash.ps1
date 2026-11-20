param(
  [Parameter(Mandatory=$true)][ValidateSet('arm64-v8a','armeabi-v7a','x86_64','x86')][string]$Abi,
  [Parameter(Mandatory=$true)][string]$BashBinary
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$androidRoot = Join-Path $projectRoot 'src-tauri\gen\android'
if (-not (Test-Path -LiteralPath $androidRoot)) { throw 'Run pnpm android:init after installing the Android SDK and NDK first.' }
$source = (Resolve-Path -LiteralPath $BashBinary).Path
$bytes = [System.IO.File]::ReadAllBytes($source)
if ($bytes.Length -lt 64 -or $bytes[0] -ne 127 -or $bytes[1] -ne 69 -or $bytes[2] -ne 76 -or $bytes[3] -ne 70) { throw 'Supply a cross-compiled Android ELF executable, not a desktop binary or shell script.' }
$expectedMachine = @{ 'arm64-v8a'=183; 'armeabi-v7a'=40; 'x86_64'=62; 'x86'=3 }
if ($bytes[5] -ne 1 -or [BitConverter]::ToUInt16($bytes,18) -ne $expectedMachine[$Abi]) { throw 'ELF architecture does not match the selected Android ABI.' }
$destination = Join-Path $androidRoot "app\src\main\jniLibs\$Abi"
New-Item -ItemType Directory -Path $destination -Force | Out-Null
Copy-Item -LiteralPath $source -Destination (Join-Path $destination 'libbash.so')
$gradle = Join-Path $androidRoot 'app\build.gradle.kts'
$contents = [System.IO.File]::ReadAllText($gradle)
if (-not $contents.Contains('// eassh bundled shell runtime')) {
  [System.IO.File]::AppendAllText($gradle, @'

// eassh bundled shell runtime: executable code is extracted from the signed APK.
android {
  packaging {
    jniLibs {
      useLegacyPackaging = true
      keepDebugSymbols.add("**/libbash.so")
    }
  }
}
'@)
}
Write-Output "Packaged Bash for $Abi. Include its required Android shared libraries and distribution notices, then rebuild the APK."
