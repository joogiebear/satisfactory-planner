; Uninstaller: let people choose whether the extracted game models go too.
;
; The models are ~64 MB pulled out of the player's own copy of Satisfactory and
; take about twelve minutes to rebuild, so an upgrade must never touch them --
; and an upgrade is exactly when a blunt "delete app data on uninstall" setting
; would: electron-builder runs the OLD uninstaller as part of installing a new
; version. So the choice is offered only on a real, interactive uninstall, and
; defaults to keeping the data. Anything silent or updating keeps it outright.

!include nsDialogs.nsh
!include LogicLib.nsh

; electron-builder compiles this file twice: once for the uninstaller, once for
; the installer that embeds it. Everything below is uninstaller-only, and
; leaving it visible to the installer pass draws warnings the build treats as
; fatal -- uninstaller code with no WriteUninstaller, then variables declared
; and never used.
!ifdef BUILD_UNINSTALLER

Var UnDeleteDataBox
Var UnDeleteData

; Replaces the stock uninstaller welcome page, which is where this decision
; belongs: it has to be made before the uninstall runs, not after.
!macro customUnWelcomePage
  UninstPage custom un.WelcomePageShow un.WelcomePageLeave
!macroend

Function un.WelcomePageShow
  StrCpy $UnDeleteData "0"

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 24u "This will remove ${PRODUCT_NAME} from your computer.$\r$\n$\r$\nThe building models it extracted from your copy of Satisfactory are kept by default, along with your saved plan and settings."
  Pop $0

  ${NSD_CreateCheckbox} 0 36u 100% 12u "Also delete the extracted models, my plan and my settings"
  Pop $UnDeleteDataBox

  ${NSD_CreateLabel} 12u 50u 100% 24u "Leave this unticked if you are reinstalling or updating. Re-extracting the models takes several minutes and needs Satisfactory installed."
  Pop $0

  nsDialogs::Show
FunctionEnd

Function un.WelcomePageLeave
  ${NSD_GetState} $UnDeleteDataBox $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $UnDeleteData "1"
  ${Else}
    StrCpy $UnDeleteData "0"
  ${EndIf}
FunctionEnd
!endif

; Runs at the end of the uninstall section. The guards are deliberately
; belt-and-braces: the page cannot run silently, but an update path that
; somehow reached here must still never delete a player's models.
!macro customUnInstall
  ${IfNot} ${isUpdated}
  ${AndIfNot} ${Silent}
  ${AndIf} $UnDeleteData == "1"
    ; Electron keeps app data per user even for a machine-wide install.
    ${If} $installMode == "all"
      SetShellVarContext current
    ${EndIf}

    RMDir /r "$APPDATA\${APP_FILENAME}"
    !ifdef APP_PRODUCT_FILENAME
      RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}"
    !endif
    !ifdef APP_PACKAGE_NAME
      RMDir /r "$APPDATA\${APP_PACKAGE_NAME}"
    !endif

    ${If} $installMode == "all"
      SetShellVarContext all
    ${EndIf}
  ${EndIf}
!macroend
