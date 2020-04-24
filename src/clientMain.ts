"use strict";

import * as path from "path";
import * as fs from "fs";
import * as tools from "./SwiftTools";
import {
  workspace,
  window,
  commands,
  languages,
  ExtensionContext,
  DiagnosticCollection,
  StatusBarItem,
  StatusBarAlignment,
  OutputChannel,
  debug
} from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
  Executable
} from "vscode-languageclient";
import { absolutePath } from "./AbsolutePath";
import { promisify } from "util";

let swiftBinPath: string | null = null;
let swiftBuildParams: string[] = ["build"];
let swiftPackageManifestPath: string | null = null;
let skProtocolProcess: string | null = null;
let skProtocolProcessAsShellCmd: string | null = null;
export let isTracingOn: boolean = false;
export let isLSPServerTracingOn: boolean = false;
export let diagnosticCollection: DiagnosticCollection;
let spmChannel: OutputChannel = null;

function shouldBuildOnSave(): boolean {
  const should = workspace.getConfiguration().get<boolean>("sde.buildOnSave");
  if (should === undefined) {
    return true;
  } else {
    return should;
  }
}

async function currentServerOptions(
  context: ExtensionContext
): Promise<ServerOptions> {
  function sourcekiteServerOptions() {
    // The server is implemented in node
    const serverModule = context.asAbsolutePath(
      path.join("out/src/server", "server.js")
    );
    // The debug options for the server
    const debugOptions = {
      execArgv: ["--nolazy", "--inspect=6004"],
      ...process.env
    };

    // If the extension is launched in debug mode then the debug server options are used
    // Otherwise the run options are used
    const serverOptions: ServerOptions = {
      run: {
        module: serverModule,
        transport: TransportKind.ipc,
        options: debugOptions
      },
      debug: {
        module: serverModule,
        transport: TransportKind.ipc,
        options: debugOptions
      }
    };
    return serverOptions;
  }

  function lspServerOptions() {
    // Load the path to the language server from settings
    const executableCommand = workspace
      .getConfiguration("swift")
      .get("languageServerPath", "/usr/local/bin/LanguageServer");

    const run: Executable = {
      command: executableCommand,
      options: process.env
    };
    const debug: Executable = run;
    const serverOptions: ServerOptions = {
      run: run,
      debug: debug
    };
    return serverOptions;
  }

  async function sourcekitLspServerOptions() {
    const toolchain = workspace
      .getConfiguration("sourcekit-lsp")
      .get<string>("toolchainPath");

    async function sourceKitLSPLocation() {
      const explicit = workspace
        .getConfiguration("sourcekit-lsp")
        .get<string | null>("serverPath", null);
      if (explicit) return explicit;

      const sourcekitLSPPath = path.resolve(
        toolchain ||
          "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain",
        "usr/bin/sourcekit-lsp"
      );
      const isPreinstalled = await promisify(fs.exists)(
        path.resolve(toolchain, "usr/bin/sourcekit-lsp")
      );
      if (isPreinstalled) {
        return sourcekitLSPPath;
      }

      return workspace
        .getConfiguration("swift")
        .get("languageServerPath", "/usr/local/bin/sourcekit-lsp");
    }

    // sourcekit-lsp takes -Xswiftc arguments like "swift build", but it doesn't need "build" argument
    let sourceKitArgs = (
      <string[]>workspace.getConfiguration().get("sde.swiftBuildingParams") ||
      []
    ).filter(param => param !== "build");

    const env: NodeJS.ProcessEnv = toolchain
      ? { ...process.env, SOURCEKIT_TOOLCHAIN_PATH: toolchain }
      : process.env;

    const run: Executable = {
      command: await sourceKitLSPLocation(),
      options: { env },
      args: sourceKitArgs
    };
    const serverOptions: ServerOptions = run;
    return serverOptions;
  }

  const lspMode = workspace
    .getConfiguration("sde")
    .get("languageServerMode", "sourcekit-lsp");

  if (lspMode === "sourcekit-lsp") {
    return sourcekitLspServerOptions();
  } else if (lspMode === "langserver") {
    return lspServerOptions();
  } else {
    return sourcekiteServerOptions();
  }
}

function currentClientOptions(
  _context: ExtensionContext
): Partial<LanguageClientOptions> {
  const lspMode = workspace.getConfiguration("sde").get("languageServerMode");
  if (lspMode === "sourcekit-lsp") {
    return {
      documentSelector: ["swift", "cpp", "c", "objective-c", "objective-cpp"],
      synchronize: undefined
    };
  } else {
    return {};
  }
}

export async function activate(context: ExtensionContext) {
  if (workspace.getConfiguration().get<boolean>("sde.enable") === false) {
    return;
  }
  initConfig();

  // Options to control the language client
  let clientOptions: LanguageClientOptions = {
    // Register the server for plain text documents
    documentSelector: [
      { language: "swift", scheme: "file" },
      { pattern: "*.swift", scheme: "file" }
    ],
    synchronize: {
      configurationSection: ["swift", "editor", "[swift]"],
      // Notify the server about file changes to '.clientrc files contain in the workspace
      fileEvents: [
        workspace.createFileSystemWatcher("**/*.swift"),
        workspace.createFileSystemWatcher(".build/*.yaml")
      ]
    },
    initializationOptions: {
      isLSPServerTracingOn: isLSPServerTracingOn,
      skProtocolProcess: skProtocolProcess,
      skProtocolProcessAsShellCmd: skProtocolProcessAsShellCmd,
      skCompilerOptions: workspace
        .getConfiguration()
        .get("sde.sourcekit.compilerOptions"),
      toolchainPath:
        workspace
          .getConfiguration("sourcekit-lsp")
          .get<string>("toolchainPath") || null
    },
    ...currentClientOptions(context)
  };

  // Create the language client and start the client.
  const langClient = new LanguageClient(
    "Swift",
    await currentServerOptions(context),
    clientOptions
  );
  let disposable = langClient.start();
  context.subscriptions.push(disposable);
  diagnosticCollection = languages.createDiagnosticCollection("swift");
  context.subscriptions.push(diagnosticCollection);

  function buildSPMPackage() {
    if (isSPMProject()) {
      //setup
      if (!buildStatusItem) {
        initBuildStatusItem();
      }

      makeBuildStatusStarted();
      tools.buildPackage(swiftBinPath, workspace.rootPath, swiftBuildParams);
    }
  }
  //commands
  context.subscriptions.push(
    commands.registerCommand("sde.commands.buildPackage", buildSPMPackage)
  );

  if (shouldBuildOnSave()) {
    // build on save
    workspace.onDidSaveTextDocument(
      document => {
        if (document.languageId === "swift") {
          buildSPMPackage();
        }
      },
      null,
      context.subscriptions
    );
  }

  // build on startup
  buildSPMPackage();
}

function initConfig() {
  checkToolsAvailability();

  isTracingOn = <boolean>(
    workspace.getConfiguration().get("sde.enableTracing.client")
  );
  isLSPServerTracingOn = <boolean>(
    workspace.getConfiguration().get("sde.enableTracing.LSPServer")
  );
  //FIXME rootPath may be undefined for adhoc file editing mode???
  swiftPackageManifestPath = path.join(workspace.rootPath, "Package.swift");

  spmChannel = window.createOutputChannel("SPM");
}

export let buildStatusItem: StatusBarItem;
let originalBuildStatusItemColor = null;
function initBuildStatusItem() {
  buildStatusItem = window.createStatusBarItem(StatusBarAlignment.Left);
  originalBuildStatusItemColor = buildStatusItem.color;
}

const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let building: NodeJS.Timer | null = null;

function makeBuildStatusStarted() {
  buildStatusItem.color = originalBuildStatusItemColor;
  buildStatusItem.show();
  let animation = frame();
  if (building) {
    clearInterval(building);
  }
  building = setInterval(() => {
    buildStatusItem.text = `${animation()} building`;
  }, 100);
}

function frame() {
  var i = 0;
  return function() {
    return frames[(i = ++i % frames.length)];
  };
}

export function makeBuildStatusFailed() {
  clearInterval(building);
  buildStatusItem.text = "$(issue-opened) build failed";
  buildStatusItem.color = "red";
}

export function makeBuildStatusSuccessful() {
  clearInterval(building);
  buildStatusItem.text = "$(check) build succeeded";
  buildStatusItem.color = originalBuildStatusItemColor;
}

function isSPMProject(): boolean {
  return fs.existsSync(swiftPackageManifestPath);
}

export function trace(...msg: any[]) {
  if (isTracingOn) {
    console.log(...msg);
  }
}

export function dumpInConsole(msg: string) {
  spmChannel.append(msg);
}

// function getSkProtocolProcessPath(extPath: string) {
// 	switch (os.platform()) {
// 		case 'darwin':
// 			return path.join(extPath, "bin", "macos", 'sourcekitd-repl')
// 		default://FIXME
// 			return path.join(extPath, "bin", "linux", 'sourcekitd-repl')
// 	}
// }

function checkToolsAvailability() {
  swiftBinPath = absolutePath(
    workspace.getConfiguration().get("swift.path.swift_driver_bin")
  );
  swiftBuildParams = <string[]>(
    workspace.getConfiguration().get("sde.swiftBuildingParams")
  ) || ["build"];
  const sourcekitePath = absolutePath(
    workspace.getConfiguration().get("swift.path.sourcekite")
  );
  const sourcekitePathEnableShCmd = workspace
    .getConfiguration()
    .get<string>("swift.path.sourcekiteDockerMode");
  const shellPath = absolutePath(
    workspace.getConfiguration().get("swift.path.shell")
  );
  // const useBuiltInBin = <boolean>workspace.getConfiguration().get('swift.sourcekit.use_built_in_bin')
  // if (useBuiltInBin) {
  // 	skProtocolProcess = getSkProtocolProcessPath(
  // 		extensions.getExtension(PUBLISHER_NAME).extensionPath)
  // } else {
  skProtocolProcess = sourcekitePath;
  skProtocolProcessAsShellCmd = sourcekitePathEnableShCmd;
  // }

  if (!swiftBinPath || !fs.existsSync(swiftBinPath)) {
    window.showErrorMessage(
      'missing dependent swift tool, please configure correct "swift.path.swift_driver_bin"'
    );
  }
  if (!sourcekitePathEnableShCmd) {
    if (!skProtocolProcess || !fs.existsSync(skProtocolProcess)) {
      window.showErrorMessage(
        'missing dependent sourcekite tool, please configure correct "swift.path.sourcekite"'
      );
    }
  }
  if (!shellPath || !fs.existsSync(shellPath)) {
    window.showErrorMessage(
      'missing dependent shell tool, please configure correct "swift.path.shell"'
    );
  }
}
