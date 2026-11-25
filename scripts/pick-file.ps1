param([switch]$Save, [string]$InitialDirectory)
# Native dialogs preserve the Markdown's full path so relative figures can be resolved.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
if ($Save) {
    $taskDialog = New-Object System.Windows.Forms.SaveFileDialog
    $taskDialog.FileName = 'presentation.md'
    $taskDialog.DefaultExt = 'md'
    $taskDialog.OverwritePrompt = $true
} else {
    $taskDialog = New-Object System.Windows.Forms.OpenFileDialog
    $taskDialog.CheckFileExists = $true
}
$taskDialog.Filter = 'Markdown (*.md)|*.md'
$taskDialog.Title = 'Lab Slides - Markdown'
if ($InitialDirectory) { $taskDialog.InitialDirectory = $InitialDirectory }
# An invisible topmost owner brings the picker forward even when the server has no console window.
$taskOwner = New-Object System.Windows.Forms.Form
$taskOwner.TopMost = $true
$taskOwner.ShowInTaskbar = $false
$taskOwner.Opacity = 0
$taskOwner.StartPosition = 'CenterScreen'
$taskOwner.Size = New-Object System.Drawing.Size(1,1)
try {
    $taskOwner.Show()
    $taskOwner.Activate()
    if ($taskDialog.ShowDialog($taskOwner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($taskDialog.FileName) }
} finally { $taskDialog.Dispose(); $taskOwner.Dispose() }
