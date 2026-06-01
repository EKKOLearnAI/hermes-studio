#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <unistd.h>

@interface AppDelegate : NSObject <NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, NSToolbarDelegate>
@property(nonatomic, strong) NSWindow *window;
@property(nonatomic, strong) WKWebView *webView;
@property(nonatomic, strong) NSSegmentedControl *modeSegment;
@property(nonatomic, strong) NSURL *appURL;
@property(nonatomic, strong) NSURL *miroFishURL;
@property(nonatomic, copy) NSString *launchAgentLabel;
@property(nonatomic, copy) NSString *terminalWorkingDirectory;
@property(nonatomic, copy) NSString *miroFishRootDirectory;
@property(nonatomic, copy) NSString *obsidianVaultPath;
@property(nonatomic, copy) NSString *currentView;
@end

@implementation AppDelegate

- (instancetype)init {
    self = [super init];
    if (self) {
        _appURL = [NSURL URLWithString:@"http://localhost:8648/#/hermes/chat"];
        _miroFishURL = [NSURL URLWithString:@"http://localhost:3000"];
        _launchAgentLabel = @"ai.hermes.web-ui-kk";
        _terminalWorkingDirectory = @"/Users/kk/Documents/Codex/2026-05-18/http-localhost-8648-hermes-chat";
        _miroFishRootDirectory = @"/Users/kk/Documents/Codex/Hermes-Quant-Workspace/mirofish";
        _obsidianVaultPath = @"/Users/kk/Documents/KK-Obsidian";
        _currentView = @"hermes";
    }
    return self;
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    [self configureMenu];
    [self ensureHermesService];
    [self createWindow];
    [self openTerminalWindow:nil];
    [self openObsidianVault:nil];
    [self loadWhenReady:0];
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender {
    return YES;
}

- (void)configureMenu {
    NSMenu *mainMenu = [[NSMenu alloc] initWithTitle:@""];
    NSMenuItem *appMenuItem = [[NSMenuItem alloc] initWithTitle:@"" action:nil keyEquivalent:@""];
    [mainMenu addItem:appMenuItem];

    NSMenu *appMenu = [[NSMenu alloc] initWithTitle:@"Hermes"];
    [appMenu addItemWithTitle:@"Hermes 聊天" action:@selector(showHermesChat:) keyEquivalent:@"1"];
    [appMenu addItemWithTitle:@"MiroFish UI" action:@selector(showMiroFishUI:) keyEquivalent:@"2"];
    [appMenu addItemWithTitle:@"Obsidian 知識庫" action:@selector(showObsidianKnowledge:) keyEquivalent:@"3"];
    [appMenu addItem:[NSMenuItem separatorItem]];
    [appMenu addItemWithTitle:@"重新載入" action:@selector(reloadPage:) keyEquivalent:@"r"];
    [appMenu addItemWithTitle:@"開啟終端" action:@selector(openTerminalWindow:) keyEquivalent:@"t"];
    [appMenu addItemWithTitle:@"開啟 MiroFish 終端" action:@selector(openMiroFishTerminal:) keyEquivalent:@"m"];
    [appMenu addItemWithTitle:@"開啟 Obsidian App" action:@selector(openObsidianVault:) keyEquivalent:@"o"];
    [appMenu addItem:[NSMenuItem separatorItem]];
    [appMenu addItemWithTitle:@"結束 Hermes" action:@selector(terminate:) keyEquivalent:@"q"];
    [appMenuItem setSubmenu:appMenu];

    [NSApp setMainMenu:mainMenu];
}

- (void)createWindow {
    WKWebViewConfiguration *configuration = [[WKWebViewConfiguration alloc] init];
    configuration.websiteDataStore = [WKWebsiteDataStore defaultDataStore];
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = YES;
    configuration.userContentController = [self userContentController];

    self.webView = [[WKWebView alloc] initWithFrame:NSZeroRect configuration:configuration];
    self.webView.navigationDelegate = self;
    self.webView.UIDelegate = self;

    NSRect frame = [self preferredHermesWindowFrame];
    NSWindowStyleMask style = NSWindowStyleMaskTitled |
        NSWindowStyleMaskClosable |
        NSWindowStyleMaskMiniaturizable |
        NSWindowStyleMaskResizable |
        NSWindowStyleMaskFullSizeContentView;

    self.window = [[NSWindow alloc] initWithContentRect:frame
                                             styleMask:style
                                               backing:NSBackingStoreBuffered
                                                 defer:NO];
    self.window.title = @"Hermes";
    self.window.titlebarAppearsTransparent = YES;
    self.window.contentView = self.webView;
    if (![self shouldUseSplitLayout]) {
        [self.window center];
    }
    [self.window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
}

- (BOOL)shouldUseSplitLayout {
    NSScreen *screen = [NSScreen mainScreen];
    return screen.visibleFrame.size.width >= 1400;
}

- (NSRect)preferredHermesWindowFrame {
    if (![self shouldUseSplitLayout]) {
        return NSMakeRect(0, 0, 1320, 900);
    }

    NSRect visibleFrame = [NSScreen mainScreen].visibleFrame;
    CGFloat gap = 8.0;
    CGFloat terminalWidth = MAX(440.0, MIN(620.0, floor(visibleFrame.size.width * 0.34)));
    CGFloat hermesWidth = MAX(900.0, visibleFrame.size.width - terminalWidth - gap);

    if (hermesWidth + terminalWidth + gap > visibleFrame.size.width) {
        hermesWidth = visibleFrame.size.width - terminalWidth - gap;
    }

    return NSMakeRect(visibleFrame.origin.x,
                      visibleFrame.origin.y,
                      hermesWidth,
                      visibleFrame.size.height);
}

- (void)configureToolbar {
    NSToolbar *toolbar = [[NSToolbar alloc] initWithIdentifier:@"HermesMainToolbar"];
    toolbar.delegate = self;
    toolbar.allowsUserCustomization = NO;
    toolbar.displayMode = NSToolbarDisplayModeIconAndLabel;
    self.window.toolbarStyle = NSWindowToolbarStyleUnifiedCompact;
    self.window.toolbar = toolbar;
}

- (NSArray *)toolbarAllowedItemIdentifiers:(NSToolbar *)toolbar {
    return @[@"ViewSwitcher", NSToolbarFlexibleSpaceItemIdentifier];
}

- (NSArray *)toolbarDefaultItemIdentifiers:(NSToolbar *)toolbar {
    return @[@"ViewSwitcher", NSToolbarFlexibleSpaceItemIdentifier];
}

- (NSToolbarItem *)toolbar:(NSToolbar *)toolbar itemForItemIdentifier:(NSString *)itemIdentifier willBeInsertedIntoToolbar:(BOOL)flag {
    if (![itemIdentifier isEqualToString:@"ViewSwitcher"]) {
        return nil;
    }

    NSToolbarItem *item = [[NSToolbarItem alloc] initWithItemIdentifier:itemIdentifier];
    item.label = @"View";
    item.paletteLabel = @"View";

    self.modeSegment = [[NSSegmentedControl alloc] initWithFrame:NSMakeRect(0, 0, 360, 28)];
    self.modeSegment.segmentCount = 3;
    self.modeSegment.trackingMode = NSSegmentSwitchTrackingSelectOne;
    self.modeSegment.target = self;
    self.modeSegment.action = @selector(switchViewFromSegment:);
    [self.modeSegment setLabel:@"Hermes" forSegment:0];
    [self.modeSegment setLabel:@"MiroFish" forSegment:1];
    [self.modeSegment setLabel:@"Obsidian" forSegment:2];
    [self.modeSegment setSelectedSegment:0];
    [self.modeSegment setWidth:110 forSegment:0];
    [self.modeSegment setWidth:120 forSegment:1];
    [self.modeSegment setWidth:130 forSegment:2];

    item.view = self.modeSegment;
    item.minSize = NSMakeSize(360, 28);
    item.maxSize = NSMakeSize(360, 28);
    return item;
}

- (void)ensureHermesService {
    uid_t uid = getuid();
    NSString *serviceTarget = [NSString stringWithFormat:@"gui/%u/%@", uid, self.launchAgentLabel];
    [self runExecutable:@"/bin/launchctl" arguments:@[@"kickstart", serviceTarget]];

    if (![self isWebUiReady]) {
        NSString *plistPath = [NSHomeDirectory() stringByAppendingPathComponent:
            [NSString stringWithFormat:@"Library/LaunchAgents/%@.plist", self.launchAgentLabel]];
        [self runExecutable:@"/bin/launchctl" arguments:@[@"bootstrap", [NSString stringWithFormat:@"gui/%u", uid], plistPath]];
        [self runExecutable:@"/bin/launchctl" arguments:@[@"kickstart", serviceTarget]];
    }
}

- (void)loadWhenReady:(NSInteger)attempt {
    if (![self.currentView isEqualToString:@"hermes"]) {
        return;
    }

    if ([self isWebUiReady] || attempt >= 45) {
        [self.webView loadRequest:[NSURLRequest requestWithURL:self.appURL]];
        return;
    }

    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        [self loadWhenReady:attempt + 1];
    });
}

- (BOOL)isWebUiReady {
    return [self runExecutable:@"/usr/bin/curl"
                     arguments:@[@"-fsS", @"--max-time", @"1", @"http://127.0.0.1:8648/"]] == 0;
}

- (BOOL)isMiroFishReady {
    return [self runExecutable:@"/usr/bin/curl"
                     arguments:@[@"-fsS", @"--max-time", @"1", @"http://127.0.0.1:3000/"]] == 0;
}

- (WKUserContentController *)userContentController {
    WKUserContentController *controller = [[WKUserContentController alloc] init];
    NSString *token = [self webUiToken];
    NSString *profile = [self activeProfileName];

    if (token.length > 0) {
        NSString *source = [NSString stringWithFormat:
            @"try { localStorage.setItem('hermes_api_key', %@); localStorage.setItem('hermes_active_profile_name', %@); } catch (e) {}",
            [self javaScriptStringLiteral:token],
            [self javaScriptStringLiteral:profile.length > 0 ? profile : @"kk"]];
        WKUserScript *script = [[WKUserScript alloc] initWithSource:source
                                                     injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                                                  forMainFrameOnly:YES];
        [controller addUserScript:script];
    }

    return controller;
}

- (NSString *)activeProfileName {
    NSDictionary *env = [self launchAgentEnvironment];
    NSString *profile = env[@"PROFILE"];
    return profile.length > 0 ? profile : @"kk";
}

- (NSString *)webUiToken {
    NSString *tokenPath = [[self webUiHome] stringByAppendingPathComponent:@".token"];
    NSString *token = [NSString stringWithContentsOfFile:tokenPath encoding:NSUTF8StringEncoding error:nil];
    return [token stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
}

- (NSString *)webUiHome {
    NSDictionary *env = [self launchAgentEnvironment];
    NSString *explicitHome = env[@"HERMES_WEB_UI_HOME"] ?: env[@"HERMES_WEBUI_STATE_DIR"];
    if (explicitHome.length > 0) {
        return [explicitHome stringByExpandingTildeInPath];
    }

    NSString *launchHome = env[@"HOME"];
    if (launchHome.length > 0) {
        return [launchHome stringByAppendingPathComponent:@".hermes-web-ui"];
    }

    return [NSHomeDirectory() stringByAppendingPathComponent:@".hermes-web-ui"];
}

- (NSDictionary *)launchAgentEnvironment {
    NSString *plistPath = [NSHomeDirectory() stringByAppendingPathComponent:
        [NSString stringWithFormat:@"Library/LaunchAgents/%@.plist", self.launchAgentLabel]];
    NSDictionary *plist = [NSDictionary dictionaryWithContentsOfFile:plistPath];
    NSDictionary *env = plist[@"EnvironmentVariables"];
    return [env isKindOfClass:[NSDictionary class]] ? env : @{};
}

- (NSString *)javaScriptStringLiteral:(NSString *)value {
    NSData *data = [NSJSONSerialization dataWithJSONObject:@[value] options:0 error:nil];
    NSString *arrayLiteral = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    if (arrayLiteral.length >= 2) {
        return [arrayLiteral substringWithRange:NSMakeRange(1, arrayLiteral.length - 2)];
    }
    return @"\"\"";
}

- (int)runExecutable:(NSString *)executable arguments:(NSArray<NSString *> *)arguments {
    NSTask *task = [[NSTask alloc] init];
    task.launchPath = executable;
    task.arguments = arguments;
    task.standardOutput = [NSFileHandle fileHandleWithNullDevice];
    task.standardError = [NSFileHandle fileHandleWithNullDevice];

    @try {
        [task launch];
        [task waitUntilExit];
        return task.terminationStatus;
    } @catch (NSException *exception) {
        return -1;
    }
}

- (void)openTerminalWindow:(id)sender {
    NSString *workingDirectory = [self existingTerminalWorkingDirectory];
    NSString *command = [NSString stringWithFormat:
        @"cd %@; printf '\\033]0;Hermes Terminal\\007'; clear; "
         "echo 'Hermes Terminal'; "
         "echo 'Profile: kk'; "
         "echo 'Web UI: %@'; "
         "echo ''; "
         "echo 'Useful commands:'; "
         "echo '  hermes --profile kk gateway status'; "
         "echo '  hermes --profile kk cron status'; "
         "echo ''; "
         "exec /bin/zsh -l",
        [self shellQuotedString:workingDirectory],
        self.appURL.absoluteString];

    NSString *script =
        @"on run argv\n"
         "  set commandText to item 1 of argv\n"
         "  tell application \"Terminal\"\n"
         "    do script commandText\n"
         "    activate\n"
         "    try\n"
         "      tell application \"Finder\" to set screenBounds to bounds of window of desktop\n"
         "      set screenRight to item 3 of screenBounds\n"
         "      set screenBottom to item 4 of screenBounds\n"
         "      set terminalWidth to 560\n"
         "      set terminalLeft to screenRight - terminalWidth\n"
         "      set bounds of front window to {terminalLeft, 48, screenRight, screenBottom - 48}\n"
         "    end try\n"
         "  end tell\n"
         "end run";

    [self runExecutable:@"/usr/bin/osascript" arguments:@[@"-e", script, command]];
    [self.window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
}

- (void)openMiroFishTerminal:(id)sender {
    NSString *workingDirectory = [self existingMiroFishRootDirectory];
    NSString *command = [NSString stringWithFormat:
        @"cd %@; printf '\\033]0;MiroFish Terminal\\007'; clear; "
         "echo 'MiroFish Terminal'; "
         "echo 'UI: %@'; "
         "echo 'Backend API: http://localhost:5001'; "
         "echo ''; "
         "if [ ! -d node_modules ] || [ ! -d frontend/node_modules ] || [ ! -d backend/.venv ]; then "
         "  echo '目前看起來尚未完整安裝 MiroFish 依賴。'; "
         "  echo '首次設定可執行：npm run setup:all'; "
         "else "
         "  echo '依賴看起來已存在，可執行：npm run dev'; "
         "fi; "
         "echo ''; "
         "echo '注意：正式模擬前需要確認 .env、LLM 與 Zep 設定。'; "
         "echo '不要把 API key/token 寫入 Obsidian 或聊天紀錄。'; "
         "echo ''; "
         "exec /bin/zsh -l",
        [self shellQuotedString:workingDirectory],
        self.miroFishURL.absoluteString];

    NSString *script =
        @"on run argv\n"
         "  set commandText to item 1 of argv\n"
         "  tell application \"Terminal\"\n"
         "    do script commandText\n"
         "    activate\n"
         "    try\n"
         "      tell application \"Finder\" to set screenBounds to bounds of window of desktop\n"
         "      set screenRight to item 3 of screenBounds\n"
         "      set screenBottom to item 4 of screenBounds\n"
         "      set terminalWidth to 560\n"
         "      set terminalLeft to screenRight - terminalWidth\n"
         "      set bounds of front window to {terminalLeft, 48, screenRight, screenBottom - 48}\n"
         "    end try\n"
         "  end tell\n"
         "end run";

    [self runExecutable:@"/usr/bin/osascript" arguments:@[@"-e", script, command]];
    [self.window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
}

- (NSString *)existingTerminalWorkingDirectory {
    BOOL isDirectory = NO;
    if ([[NSFileManager defaultManager] fileExistsAtPath:self.terminalWorkingDirectory isDirectory:&isDirectory] && isDirectory) {
        return self.terminalWorkingDirectory;
    }
    return NSHomeDirectory();
}

- (NSString *)existingMiroFishRootDirectory {
    BOOL isDirectory = NO;
    if ([[NSFileManager defaultManager] fileExistsAtPath:self.miroFishRootDirectory isDirectory:&isDirectory] && isDirectory) {
        return self.miroFishRootDirectory;
    }
    return NSHomeDirectory();
}

- (NSString *)existingObsidianVaultPath {
    BOOL isDirectory = NO;
    if ([[NSFileManager defaultManager] fileExistsAtPath:self.obsidianVaultPath isDirectory:&isDirectory] && isDirectory) {
        return self.obsidianVaultPath;
    }
    return NSHomeDirectory();
}

- (void)openObsidianVault:(id)sender {
    NSString *vaultPath = [self existingObsidianVaultPath];
    NSString *urlString = [NSString stringWithFormat:@"obsidian://open?path=%@",
        [self percentEncodedQueryValue:[vaultPath stringByAppendingPathComponent:@"Hermes-Knowledge/index.md"]]];
    NSURL *url = [NSURL URLWithString:urlString];

    if (url) {
        [[NSWorkspace sharedWorkspace] openURL:url];
    }

    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        [self.window makeKeyAndOrderFront:nil];
        [NSApp activateIgnoringOtherApps:YES];
    });
}

- (NSString *)percentEncodedQueryValue:(NSString *)value {
    NSCharacterSet *allowed = [NSCharacterSet URLQueryAllowedCharacterSet];
    return [value stringByAddingPercentEncodingWithAllowedCharacters:allowed];
}

- (NSString *)shellQuotedString:(NSString *)value {
    NSString *escaped = [value stringByReplacingOccurrencesOfString:@"'" withString:@"'\\''"];
    return [NSString stringWithFormat:@"'%@'", escaped];
}

- (void)switchViewFromSegment:(id)sender {
    if (self.modeSegment.selectedSegment == 2) {
        [self showObsidianKnowledge:sender];
    } else if (self.modeSegment.selectedSegment == 1) {
        [self showMiroFishUI:sender];
    } else {
        [self showHermesChat:sender];
    }
}

- (void)showHermesChat:(id)sender {
    self.currentView = @"hermes";
    [self.modeSegment setSelectedSegment:0];
    [self loadWhenReady:0];
}

- (void)showMiroFishUI:(id)sender {
    self.currentView = @"mirofish";
    [self.modeSegment setSelectedSegment:1];

    if ([self isMiroFishReady]) {
        [self.webView loadRequest:[NSURLRequest requestWithURL:self.miroFishURL]];
        return;
    }

    [self.webView loadHTMLString:[self miroFishUnavailableHTML] baseURL:nil];
}

- (void)showObsidianKnowledge:(id)sender {
    self.currentView = @"obsidian";
    [self.modeSegment setSelectedSegment:2];
    [self openObsidianVault:nil];
    [self.webView loadHTMLString:[self obsidianKnowledgeHTML] baseURL:nil];
}

- (void)reloadPage:(id)sender {
    if ([self.currentView isEqualToString:@"mirofish"]) {
        [self showMiroFishUI:sender];
    } else if ([self.currentView isEqualToString:@"obsidian"]) {
        [self showObsidianKnowledge:sender];
    } else {
        [self.webView reload];
    }
}

- (void)scheduleReload {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(2 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        if ([self.currentView isEqualToString:@"mirofish"]) {
            [self showMiroFishUI:nil];
        } else if ([self.currentView isEqualToString:@"obsidian"]) {
            [self showObsidianKnowledge:nil];
        } else {
            [self.webView loadRequest:[NSURLRequest requestWithURL:self.appURL]];
        }
    });
}

- (void)webView:(WKWebView *)webView didFailNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    [self scheduleReload];
}

- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    [self scheduleReload];
}

- (void)webView:(WKWebView *)webView
decidePolicyForNavigationAction:(WKNavigationAction *)navigationAction
decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    NSURL *url = navigationAction.request.URL;

    if ([url.scheme isEqualToString:@"hermesapp"]) {
        if ([url.host isEqualToString:@"open-mirofish-terminal"]) {
            [self openMiroFishTerminal:nil];
        } else if ([url.host isEqualToString:@"reload-mirofish"]) {
            [self showMiroFishUI:nil];
        } else if ([url.host isEqualToString:@"open-hermes-terminal"]) {
            [self openTerminalWindow:nil];
        } else if ([url.host isEqualToString:@"open-obsidian-vault"]) {
            [self openObsidianVault:nil];
        } else if ([url.host isEqualToString:@"show-obsidian-knowledge"]) {
            [self showObsidianKnowledge:nil];
        }
        decisionHandler(WKNavigationActionPolicyCancel);
        return;
    }

    NSString *host = url.host.lowercaseString;
    NSSet<NSString *> *localHosts = [NSSet setWithObjects:@"localhost", @"127.0.0.1", @"::1", nil];

    if (host.length > 0 && ![localHosts containsObject:host]) {
        [[NSWorkspace sharedWorkspace] openURL:url];
        decisionHandler(WKNavigationActionPolicyCancel);
        return;
    }

    decisionHandler(WKNavigationActionPolicyAllow);
}

- (WKWebView *)webView:(WKWebView *)webView
createWebViewWithConfiguration:(WKWebViewConfiguration *)configuration
   forNavigationAction:(WKNavigationAction *)navigationAction
        windowFeatures:(WKWindowFeatures *)windowFeatures {
    if (navigationAction.targetFrame == nil) {
        [webView loadRequest:navigationAction.request];
    }
    return nil;
}

- (NSString *)miroFishUnavailableHTML {
    NSString *root = [self htmlEscapedString:[self existingMiroFishRootDirectory]];
    NSString *uiURL = [self htmlEscapedString:self.miroFishURL.absoluteString];
    NSString *setupCommand = [self htmlEscapedString:
        @"cd /Users/kk/Documents/Codex/Hermes-Quant-Workspace/mirofish && npm run setup:all"];
    NSString *devCommand = [self htmlEscapedString:
        @"cd /Users/kk/Documents/Codex/Hermes-Quant-Workspace/mirofish && npm run dev"];

    return [NSString stringWithFormat:
        @"<!doctype html>"
         "<html lang='zh-Hant'>"
         "<head>"
         "<meta charset='utf-8'>"
         "<meta name='viewport' content='width=device-width, initial-scale=1'>"
         "<style>"
         "body{margin:0;background:#f7f7f4;color:#202124;font:14px -apple-system,BlinkMacSystemFont,'SF Pro Text','Noto Sans TC',sans-serif;}"
         ".wrap{max-width:860px;margin:64px auto;padding:0 28px;}"
         ".eyebrow{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#6b7280;margin-bottom:16px;}"
         "h1{font-size:32px;line-height:1.15;margin:0 0 16px;font-weight:760;}"
         "p{font-size:15px;line-height:1.65;margin:0 0 14px;color:#3f3f46;}"
         ".panel{background:white;border:1px solid #deded8;border-radius:8px;padding:20px;margin-top:22px;box-shadow:0 1px 2px rgba(0,0,0,.04);}"
         ".row{display:grid;grid-template-columns:160px 1fr;gap:12px;padding:8px 0;border-bottom:1px solid #eee;}"
         ".row:last-child{border-bottom:0;}"
         ".label{color:#6b7280;}"
         "code{font-family:'SF Mono',Menlo,monospace;background:#f1f1ee;border:1px solid #deded8;border-radius:6px;padding:2px 6px;}"
         ".commands code{display:block;white-space:pre-wrap;padding:10px;margin-top:8px;}"
         ".actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:22px;}"
         ".button{display:inline-flex;align-items:center;justify-content:center;height:36px;padding:0 14px;border-radius:7px;background:#111827;color:white;text-decoration:none;font-weight:650;}"
         ".button.secondary{background:white;color:#111827;border:1px solid #d4d4d0;}"
         ".note{margin-top:18px;font-size:13px;color:#71717a;}"
         "</style>"
         "</head>"
         "<body>"
         "<main class='wrap'>"
         "<div class='eyebrow'>MiroFish UI</div>"
         "<h1>MiroFish 尚未在本機啟動</h1>"
         "<p>Hermes App 已加入 MiroFish 入口。等 MiroFish 前端跑在 <code>%@</code> 後，切到 MiroFish 會直接顯示它的 UI。</p>"
         "<section class='panel'>"
         "<div class='row'><div class='label'>Source</div><div><code>%@</code></div></div>"
         "<div class='row'><div class='label'>Frontend</div><div><code>localhost:3000</code></div></div>"
         "<div class='row'><div class='label'>Backend API</div><div><code>localhost:5001</code></div></div>"
         "<div class='row'><div class='label'>Status</div><div>目前沒有偵測到 MiroFish frontend 回應。</div></div>"
         "</section>"
         "<section class='panel commands'>"
         "<p>首次設定依賴：</p><code>%@</code>"
         "<p style='margin-top:14px'>之後啟動 UI / backend：</p><code>%@</code>"
         "</section>"
         "<div class='actions'>"
         "<a class='button' href='hermesapp://open-mirofish-terminal'>開啟 MiroFish 終端</a>"
         "<a class='button secondary' href='hermesapp://reload-mirofish'>重新檢查 UI</a>"
         "</div>"
         "<p class='note'>正式模擬前請先確認 <code>.env</code>、LLM API 與 Zep 設定；不要把 API key 或 token 寫入聊天紀錄或 Obsidian。</p>"
         "</main>"
         "</body>"
         "</html>",
        uiURL, root, setupCommand, devCommand];
}

- (NSString *)obsidianKnowledgeHTML {
    NSString *vaultPath = [self htmlEscapedString:[self existingObsidianVaultPath]];
    NSString *knowledgeIndex = [self htmlEscapedString:
        [[self existingObsidianVaultPath] stringByAppendingPathComponent:@"Hermes-Knowledge/index.md"]];

    return [NSString stringWithFormat:
        @"<!doctype html>"
         "<html lang='zh-Hant'>"
         "<head>"
         "<meta charset='utf-8'>"
         "<meta name='viewport' content='width=device-width, initial-scale=1'>"
         "<style>"
         "body{margin:0;background:#f7f7f4;color:#202124;font:14px -apple-system,BlinkMacSystemFont,'SF Pro Text','Noto Sans TC',sans-serif;}"
         ".wrap{max-width:860px;margin:64px auto;padding:0 28px;}"
         ".eyebrow{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#6b7280;margin-bottom:16px;}"
         "h1{font-size:32px;line-height:1.15;margin:0 0 16px;font-weight:760;}"
         "p{font-size:15px;line-height:1.65;margin:0 0 14px;color:#3f3f46;}"
         ".panel{background:white;border:1px solid #deded8;border-radius:8px;padding:20px;margin-top:22px;box-shadow:0 1px 2px rgba(0,0,0,.04);}"
         ".row{display:grid;grid-template-columns:160px 1fr;gap:12px;padding:8px 0;border-bottom:1px solid #eee;}"
         ".row:last-child{border-bottom:0;}"
         ".label{color:#6b7280;}"
         "code{font-family:'SF Mono',Menlo,monospace;background:#f1f1ee;border:1px solid #deded8;border-radius:6px;padding:2px 6px;word-break:break-all;}"
         ".actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:22px;}"
         ".button{display:inline-flex;align-items:center;justify-content:center;height:36px;padding:0 14px;border-radius:7px;background:#111827;color:white;text-decoration:none;font-weight:650;}"
         ".button.secondary{background:white;color:#111827;border:1px solid #d4d4d0;}"
         ".note{margin-top:18px;font-size:13px;color:#71717a;}"
         "</style>"
         "</head>"
         "<body>"
         "<main class='wrap'>"
         "<div class='eyebrow'>Obsidian Knowledge</div>"
         "<h1>Obsidian 已接到 Hermes App</h1>"
         "<p>開啟 Hermes App icon 時會同步帶起 Obsidian。Hermes 負責執行、整理與寫入；Obsidian 保留原生 vault、外掛、Graph View 與 Markdown 編輯能力。</p>"
         "<section class='panel'>"
         "<div class='row'><div class='label'>Vault</div><div><code>%@</code></div></div>"
         "<div class='row'><div class='label'>Knowledge Index</div><div><code>%@</code></div></div>"
         "<div class='row'><div class='label'>Mode</div><div>同一個 Hermes App icon 同時開啟，Obsidian 以原生 App 分窗運作。</div></div>"
         "</section>"
         "<div class='actions'>"
         "<a class='button' href='hermesapp://open-obsidian-vault'>開啟 Obsidian</a>"
         "<a class='button secondary' href='hermesapp://open-hermes-terminal'>開啟 Hermes 終端</a>"
         "</div>"
         "<p class='note'>這裡不直接嵌入 Obsidian UI，避免外掛、vault 索引與檔案鎖定問題；Hermes 仍會直接讀寫同一個 Hermes-Knowledge 資料夾。</p>"
         "</main>"
         "</body>"
         "</html>",
        vaultPath, knowledgeIndex];
}

- (NSString *)htmlEscapedString:(NSString *)value {
    NSString *escaped = [value stringByReplacingOccurrencesOfString:@"&" withString:@"&amp;"];
    escaped = [escaped stringByReplacingOccurrencesOfString:@"<" withString:@"&lt;"];
    escaped = [escaped stringByReplacingOccurrencesOfString:@">" withString:@"&gt;"];
    escaped = [escaped stringByReplacingOccurrencesOfString:@"\"" withString:@"&quot;"];
    escaped = [escaped stringByReplacingOccurrencesOfString:@"'" withString:@"&#39;"];
    return escaped;
}

@end

int main(int argc, const char * argv[]) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        AppDelegate *delegate = [[AppDelegate alloc] init];
        [NSApp setDelegate:delegate];
        [NSApp run];
    }
    return 0;
}
