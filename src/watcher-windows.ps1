# Reads foreground-window process metadata only. No DLL injection, keyboard hook or game-memory access.
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class RelayForeground {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@
$previousProcess = 0
while ($true) {
  $foregroundProcess = [uint32]0
  [void][RelayForeground]::GetWindowThreadProcessId([RelayForeground]::GetForegroundWindow(), [ref]$foregroundProcess)
  if ($foregroundProcess -ne $previousProcess) {
    try {
      $currentApp = Get-Process -Id $foregroundProcess -ErrorAction Stop
      @{pid=$foregroundProcess; name=$currentApp.ProcessName; path=$currentApp.Path} | ConvertTo-Json -Compress
    } catch {
      @{pid=$foregroundProcess; name=''; path=''} | ConvertTo-Json -Compress
    }
    $previousProcess = $foregroundProcess
  }
  Start-Sleep -Milliseconds 900
}
