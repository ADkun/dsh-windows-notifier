# dsh-windows-notifier — Windows toast companion
#
# Shows exactly one toast through the WinRT Windows.UI.Notifications types that
# Windows PowerShell v1.0 projects natively. No module, COM registration, or
# Start-menu shortcut is required when $AppId is the well-known Windows
# PowerShell AppUserModelID.
#
# Keep this file ASCII-only: Windows PowerShell decodes a BOM-less script using
# the ANSI code page, and every non-ASCII character a notification needs arrives
# through -Title / -Body as real UTF-16 arguments instead.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $Title,
    [string] $Body = '',
    [string] $AppId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe',
    [ValidateSet('default', 'silent')][string] $Sound = 'default',
    [ValidateSet('short', 'long')][string] $Duration = 'short'
)

$ErrorActionPreference = 'Stop'

[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

function ConvertTo-XmlText {
    param([string] $Value)
    if ([string]::IsNullOrEmpty($Value)) { return '' }
    return [System.Security.SecurityElement]::Escape($Value)
}

$textNodes = '<text>' + (ConvertTo-XmlText -Value $Title) + '</text>'
if (-not [string]::IsNullOrWhiteSpace($Body)) {
    foreach ($line in ($Body -split "`r?`n")) {
        if (-not [string]::IsNullOrWhiteSpace($line)) {
            $textNodes += '<text>' + (ConvertTo-XmlText -Value $line.Trim()) + '</text>'
        }
    }
}

$audio = ''
if ($Sound -eq 'silent') { $audio = '<audio silent="true" />' }

$xmlText = '<toast duration="' + $Duration + '">' +
    '<visual><binding template="ToastGeneric">' + $textNodes + '</binding></visual>' +
    $audio + '</toast>'

$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($xmlText)

$toast = New-Object Windows.UI.Notifications.ToastNotification $xml
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId).Show($toast)