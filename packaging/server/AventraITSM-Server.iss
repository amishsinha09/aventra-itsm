; Aventra ITSM Server — Windows installer (Inno Setup 6)
; Build: iscc /DAppVersion=1.0.0 AventraITSM-Server.iss   (after `node build.mjs` has filled .\stage)

#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#define AppName "Aventra ITSM Server"
#define DataDir "{commonappdata}\Aventra ITSM"

[Setup]
AppId={{6F1C2A4E-7B9D-4C3A-9E51-3A7E2B1C9D40}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=Aventra Tech
AppPublisherURL=https://aventratech.org
DefaultDirName={autopf}\Aventra ITSM
DefaultGroupName=Aventra ITSM
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputDir=..\..\dist
OutputBaseFilename=AventraITSM-Server-Setup-{#AppVersion}
SetupIconFile=..\assets\icon.ico
UninstallDisplayIcon={app}\AventraITSM.exe
WizardImageFile=..\assets\wizard-large.bmp
WizardSmallImageFile=..\assets\wizard-small.bmp
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
CloseApplications=no
SetupLogging=yes

[Tasks]
Name: "firewall"; Description: "Allow other computers on the network to reach the service desk (Windows Firewall)"; Flags: checkedonce
Name: "demo"; Description: "Load demo data (sample customers, tickets and CMDB) — for evaluation only"; Flags: unchecked

[Files]
Source: "stage\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "build\vc_redist.x64.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall

[Dirs]
Name: "{#DataDir}"; Flags: uninsneveruninstall
Name: "{#DataDir}\logs"; Flags: uninsneveruninstall

[INI]
Filename: "{group}\Aventra ITSM.url"; Section: "InternetShortcut"; Key: "URL"; String: "http://localhost:{code:GetPort}"
Filename: "{commondesktop}\Aventra ITSM.url"; Section: "InternetShortcut"; Key: "URL"; String: "http://localhost:{code:GetPort}"
Filename: "{commondesktop}\Aventra ITSM.url"; Section: "InternetShortcut"; Key: "IconFile"; String: "{app}\AventraITSM.exe"
Filename: "{commondesktop}\Aventra ITSM.url"; Section: "InternetShortcut"; Key: "IconIndex"; String: "0"

[Icons]
Name: "{group}\Configuration (config.env)"; Filename: "notepad.exe"; Parameters: """{#DataDir}\config.env"""
Name: "{group}\Logs"; Filename: "{#DataDir}\logs"
Name: "{group}\Read me"; Filename: "{app}\README.txt"
Name: "{group}\Uninstall Aventra ITSM Server"; Filename: "{uninstallexe}"

[Run]
Filename: "http://localhost:{code:GetPort}"; Description: "Open Aventra ITSM in your browser"; Flags: postinstall shellexec nowait skipifsilent

[UninstallRun]
Filename: "{app}\AventraITSM-Service.exe"; Parameters: "stop"; Flags: runhidden waituntilterminated; RunOnceId: "StopApp"
Filename: "{app}\AventraITSM-Service.exe"; Parameters: "uninstall"; Flags: runhidden waituntilterminated; RunOnceId: "RemoveApp"
Filename: "{sys}\net.exe"; Parameters: "stop AventraITSM-DB"; Flags: runhidden waituntilterminated; RunOnceId: "StopDb"
Filename: "{app}\pgsql\bin\pg_ctl.exe"; Parameters: "unregister -N AventraITSM-DB"; Flags: runhidden waituntilterminated; RunOnceId: "RemoveDb"
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Aventra ITSM"""; Flags: runhidden waituntilterminated; RunOnceId: "Firewall"

[UninstallDelete]
Type: files; Name: "{group}\Aventra ITSM.url"
Type: files; Name: "{commondesktop}\Aventra ITSM.url"

[Messages]
FinishedLabel=Aventra ITSM is running as a Windows service.%n%nOpen the service desk and create your workspace and administrator account. Other computers can reach it at http://<this-server-name>:<port>.

[Code]
var
  PortPage: TInputQueryWizardPage;

function ConfigExists(): Boolean;
begin
  Result := FileExists(ExpandConstant('{#DataDir}\config.env'));
end;

function ExistingPort(): String;
var
  Lines: TArrayOfString;
  I: Integer;
begin
  Result := '';
  if LoadStringsFromFile(ExpandConstant('{#DataDir}\config.env'), Lines) then
    for I := 0 to GetArrayLength(Lines) - 1 do
      if Pos('PORT=', Lines[I]) = 1 then
        Result := Copy(Lines[I], 6, 10);
end;

function GetPort(Param: String): String;
begin
  if ConfigExists() and (ExistingPort() <> '') then
    Result := ExistingPort()
  else if Assigned(PortPage) and (PortPage.Values[0] <> '') then
    Result := PortPage.Values[0]
  else
    Result := '8080';
end;

procedure InitializeWizard();
begin
  PortPage := CreateInputQueryPage(wpSelectTasks, 'Web server port',
    'Which port should the service desk listen on?',
    'Users will open http://<this-server>:<port> in their browser. Choose a port that is not already in use.');
  PortPage.Add('Port:', False);
  PortPage.Values[0] := '8080';
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  // Upgrades keep the existing port
  Result := (PageID = PortPage.ID) and ConfigExists();
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  P: Integer;
begin
  Result := True;
  if CurPageID = PortPage.ID then
  begin
    P := StrToIntDef(PortPage.Values[0], 0);
    if (P < 1) or (P > 65535) then
    begin
      MsgBox('Enter a port number between 1 and 65535.', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

function RunLogged(const Exe, Params, StepName: String): Boolean;
var
  Code: Integer;
  Log: String;
begin
  Log := ExpandConstant('{#DataDir}\logs\install.log');
  Result := Exec(ExpandConstant('{cmd}'), '/C ""' + Exe + '" ' + Params + ' >> "' + Log + '" 2>&1"', '', SW_HIDE, ewWaitUntilTerminated, Code) and (Code = 0);
  if not Result then
    MsgBox(StepName + ' failed (exit code ' + IntToStr(Code) + ').' + #13#10#13#10 + 'Details: ' + Log, mbError, MB_OK);
end;

// Stop running services before files are replaced (upgrade)
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
begin
  Result := '';
  Exec(ExpandConstant('{sys}\sc.exe'), 'stop AventraITSM', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Sleep(3000);
  Exec(ExpandConstant('{sys}\net.exe'), 'stop AventraITSM-DB', '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Code: Integer;
  Args: String;
begin
  if CurStep <> ssPostInstall then Exit;

  WizardForm.StatusLabel.Caption := 'Installing Microsoft Visual C++ runtime...';
  Exec(ExpandConstant('{tmp}\vc_redist.x64.exe'), '/install /quiet /norestart', '', SW_HIDE, ewWaitUntilTerminated, Code);

  WizardForm.StatusLabel.Caption := 'Setting up the database (this can take a minute)...';
  Args := 'setup --data-dir "' + ExpandConstant('{#DataDir}') + '" --pg-bin "' + ExpandConstant('{app}\pgsql\bin') + '" --port ' + GetPort('') + ' --host ' + GetComputerNameString();
  if WizardIsTaskSelected('demo') then Args := Args + ' --demo';
  if not RunLogged(ExpandConstant('{app}\AventraITSM.exe'), Args, 'Database setup') then Exit;

  WizardForm.StatusLabel.Caption := 'Starting the Aventra ITSM service...';
  // "install" fails harmlessly if the service already exists (upgrade)
  Exec(ExpandConstant('{app}\AventraITSM-Service.exe'), 'install', '', SW_HIDE, ewWaitUntilTerminated, Code);
  RunLogged(ExpandConstant('{app}\AventraITSM-Service.exe'), 'start', 'Starting the service');

  if WizardIsTaskSelected('firewall') then
  begin
    Exec(ExpandConstant('{sys}\netsh.exe'), 'advfirewall firewall delete rule name="Aventra ITSM"', '', SW_HIDE, ewWaitUntilTerminated, Code);
    Exec(ExpandConstant('{sys}\netsh.exe'), 'advfirewall firewall add rule name="Aventra ITSM" dir=in action=allow protocol=TCP localport=' + GetPort(''), '', SW_HIDE, ewWaitUntilTerminated, Code);
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
    MsgBox('Aventra ITSM was removed. Your data and configuration were kept in:' + #13#10 + ExpandConstant('{#DataDir}') + #13#10#13#10 + 'Delete that folder if you no longer need the database.', mbInformation, MB_OK);
end;
