import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const runFile = promisify(execFile);

export async function trimProcessWorkingSets(processIds: number[]): Promise<void> {
  if (process.platform !== 'win32' || !processIds.length) return;
  if (!processIds.every(id => Number.isSafeInteger(id) && id > 0 && id <= 0x7fffffff)) {
    throw new TypeError('Invalid process ID.');
  }

  const script = `
    $ErrorActionPreference = 'Stop'
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices;
      public static class PdeMemoryCleanup {
        [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int id);
        [DllImport("psapi.dll", SetLastError = true)] public static extern bool EmptyWorkingSet(IntPtr process);
        [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
      }'
    foreach ($processId in @(${[...new Set(processIds)].join(',')})) {
      # PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_QUOTA
      $handle = [PdeMemoryCleanup]::OpenProcess(0x1100, $false, $processId)
      if ($handle -eq [IntPtr]::Zero) {
        $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        if ($errorCode -eq 87) { continue } # The process has already exited.
        throw [ComponentModel.Win32Exception]::new($errorCode)
      }
      try {
        if (-not [PdeMemoryCleanup]::EmptyWorkingSet($handle)) {
          throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())
        }
      } finally {
        [void][PdeMemoryCleanup]::CloseHandle($handle)
      }
    }
  `;
  try {
    await runFile(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000 });
  } catch (error) {
    console.error('Working set cleanup failed:', error);
    throw new Error('Windows RAM 정리를 실행하지 못했습니다.');
  }
}
