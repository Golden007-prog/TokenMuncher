; Extra pages and texts for the assisted (wizard) installer.
; electron-builder includes this file (nsis.include) and calls the macros below.

; Always install for the current user only: no "all users / only me" page,
; no administrator rights. The app keeps its data in %APPDATA%\tokenmuncher.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "TokenMuncher ${VERSION}"
  !define MUI_WELCOMEPAGE_TEXT "Shows how much of your Claude Code, Cursor, Codex and Copilot limits you have used, in a small window and in the tray.$\r$\n$\r$\nInstalled for your Windows user only, no administrator rights needed. You can pick the folder on the next page.$\r$\n$\r$\nSettings and history live in %APPDATA%\tokenmuncher and stay after an update or uninstall.$\r$\n$\r$\nIt only reads the usage data these tools already keep on this computer and talks only to their own servers."
  !insertmacro MUI_PAGE_WELCOME

  ; Read later by the finish page (MUI_PAGE_FINISH in electron-builder's template).
  !define MUI_FINISHPAGE_TITLE "TokenMuncher is installed"
  !define MUI_FINISHPAGE_TEXT "Installed in:$\r$\n$INSTDIR$\r$\n$\r$\n\
Start it from the Start Menu (TokenMuncher). While running it lives in the tray, next to the clock; click the critter to open the window.$\r$\n$\r$\n\
Starting with Windows can be switched on or off in the tray menu.$\r$\n$\r$\n\
To remove it: Settings > Apps > TokenMuncher."
!macroend

!macro customUnWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Uninstall TokenMuncher"
  !define MUI_WELCOMEPAGE_TEXT "This removes TokenMuncher ${VERSION} from:$\r$\n$INSTDIR$\r$\n$\r$\n\
Your settings and history in %APPDATA%\tokenmuncher are kept, so a later install continues where you left off. Delete that folder yourself if you want them gone.$\r$\n$\r$\n\
If TokenMuncher is running, it will be closed."
  !insertmacro MUI_UNPAGE_WELCOME
!macroend
