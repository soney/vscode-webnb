const vscode = require('vscode');
const { TextDecoder, TextEncoder } = require('util');

const NOTEBOOK_TYPE = 'webnb-debug';
const CONTROLLER_ID = 'webnb-debug-kernel';
const LOG_PREFIX = '[webnb-debug]';

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const autorunSignatures = new Map();

let controller;

function activate(context) {
  log('activate remoteName=%s extensionMode=%s', vscode.env.remoteName || '<none>', String(context.extensionMode));

  context.subscriptions.push(
    vscode.workspace.registerNotebookSerializer(NOTEBOOK_TYPE, new DebugNotebookSerializer(), {
      transientOutputs: true
    })
  );

  controller = vscode.notebooks.createNotebookController(CONTROLLER_ID, NOTEBOOK_TYPE, 'WebNB Debug');
  controller.supportedLanguages = ['javascript', 'js', 'html', 'css', 'plaintext', 'markdown'];
  controller.supportsExecutionOrder = true;
  controller.executeHandler = (cells, notebook) => executeCells(cells, `executeHandler ${notebook.uri.toString()}`);
  context.subscriptions.push(controller);

  context.subscriptions.push(
    vscode.commands.registerCommand('webnb-debug.dumpState', () => dumpState('command')),
    vscode.workspace.onDidOpenNotebookDocument(notebook => {
      if (notebook.notebookType !== NOTEBOOK_TYPE) {
        return;
      }
      log('onDidOpenNotebookDocument %s', describeUri(notebook.uri));
      selectPreferred(notebook);
      scheduleAutorunForNotebook(notebook, 'openDocument');
    }),
    vscode.window.onDidChangeVisibleNotebookEditors(editors => {
      for (const editor of editors) {
        initializeEditor(editor, 'visibleEditorsChanged');
      }
    }),
    vscode.window.onDidChangeActiveNotebookEditor(editor => {
      if (editor) {
        initializeEditor(editor, 'activeEditorChanged');
      }
    }),
    vscode.workspace.onDidChangeNotebookDocument(event => {
      if (event.notebook.notebookType === NOTEBOOK_TYPE) {
        scheduleAutorunForNotebook(event.notebook, 'documentChanged');
      }
    })
  );

  for (const editor of vscode.window.visibleNotebookEditors) {
    initializeEditor(editor, 'activate');
  }
}

function deactivate() {}

class DebugNotebookSerializer {
  deserializeNotebook(data) {
    const text = decoder.decode(data);
    const cells = parseDebugNotebook(text);
    log('deserialize bytes=%d cells=%d', data.byteLength, cells.length);
    return new vscode.NotebookData(cells);
  }

  serializeNotebook(data) {
    return encoder.encode(serializeDebugNotebook(data.cells));
  }
}

function initializeEditor(editor, reason) {
  if (editor.notebook.notebookType !== NOTEBOOK_TYPE) {
    return;
  }

  log('initializeEditor reason=%s editor=%s notebook=%s', reason, String(editor.viewColumn), describeUri(editor.notebook.uri));
  selectPreferred(editor.notebook);
  scheduleAutorun(editor, reason);
}

function selectPreferred(notebook) {
  try {
    controller.updateNotebookAffinity(notebook, vscode.NotebookControllerAffinity.Preferred);
  } catch (error) {
    logError('updateNotebookAffinity failed notebook=%s', notebook.uri.toString(), error);
  }
}

function scheduleAutorunForNotebook(notebook, reason) {
  const editor = vscode.window.visibleNotebookEditors.find(candidate => candidate.notebook === notebook);
  if (editor) {
    scheduleAutorun(editor, reason);
  }
}

function scheduleAutorun(editor, reason) {
  setTimeout(() => {
    void runAutorun(editor, reason);
  }, 100);
}

async function runAutorun(editor, reason) {
  const notebook = editor.notebook;
  if (notebook.notebookType !== NOTEBOOK_TYPE) {
    return;
  }

  const cells = notebook.getCells().filter(cell =>
    cell.kind === vscode.NotebookCellKind.Code && cell.metadata && cell.metadata.autorun === true
  );
  if (cells.length === 0) {
    log('autorun none reason=%s notebook=%s', reason, describeUri(notebook.uri));
    return;
  }

  const signature = cells.map(cell => `${cell.document.uri.toString()}@${cell.document.version}`).join('\n');
  const key = notebook.uri.toString();
  if (autorunSignatures.get(key) === signature) {
    log('autorun already ran reason=%s notebook=%s', reason, describeUri(notebook.uri));
    return;
  }

  autorunSignatures.set(key, signature);
  await executeCells(cells, `autorun ${reason}`);
}

async function executeCells(cells, reason) {
  log('executeCells start reason=%s cells=%d', reason, cells.length);
  dumpState(`before execute: ${reason}`);

  for (const cell of cells) {
    let execution;
    try {
      log('cell start %s', describeCell(cell));
      execution = controller.createNotebookCellExecution(cell);
      execution.start(Date.now());
      await execution.replaceOutput(new vscode.NotebookCellOutput([
        vscode.NotebookCellOutputItem.text([
          'WebNB Debug executed this cell.',
          `reason: ${reason}`,
          `notebook: ${cell.notebook.uri.toString()}`,
          `cell document: ${cell.document.uri.toString()}`,
          `cell index: ${cell.index}`,
          `language: ${cell.document.languageId}`,
          `source length: ${cell.document.getText().length}`
        ].join('\n'), 'text/plain')
      ]));
      execution.end(true, Date.now());
      log('cell end success %s', describeCell(cell));
    } catch (error) {
      logError(`cell execution failed ${describeCell(cell)}`, error);
      if (execution) {
        try {
          execution.end(false, Date.now());
        } catch (endError) {
          logError('cell execution end(false) failed', endError);
        }
      }
      void vscode.window.showErrorMessage(`WebNB Debug execution failed: ${formatError(error)}`);
    }
  }

  log('executeCells end reason=%s', reason);
}

function dumpState(reason) {
  const active = vscode.window.activeNotebookEditor;
  const lines = [
    `${LOG_PREFIX} state reason=${reason}`,
    `active=${active ? describeEditor(active) : '<none>'}`,
    `visible=${vscode.window.visibleNotebookEditors.map(describeEditor).join(' | ') || '<none>'}`,
    `documents=${vscode.workspace.notebookDocuments.map(describeNotebook).join(' | ') || '<none>'}`,
    `tabs=${vscode.window.tabGroups.all.flatMap(group => group.tabs).map(describeTab).join(' | ') || '<none>'}`
  ];
  console.log(lines.join('\n'));
  return lines.join('\n');
}

function parseDebugNotebook(text) {
  const cells = [];
  const lines = text.split(/\r?\n/g);
  let markdownLines = [];
  let codeLines = [];
  let inCode = false;
  let codeInfo = { language: 'plaintext', autorun: false };

  const flushMarkdown = () => {
    if (markdownLines.join('\n').trim().length === 0) {
      markdownLines = [];
      return;
    }
    cells.push(new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, markdownLines.join('\n'), 'markdown'));
    markdownLines = [];
  };

  const flushCode = () => {
    const cell = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, codeLines.join('\n'), codeInfo.language);
    cell.metadata = { autorun: codeInfo.autorun };
    cells.push(cell);
    codeLines = [];
  };

  for (const line of lines) {
    if (!inCode && line.startsWith('```')) {
      flushMarkdown();
      codeInfo = parseFenceInfo(line.slice(3));
      inCode = true;
      continue;
    }

    if (inCode && line.trim() === '```') {
      flushCode();
      inCode = false;
      continue;
    }

    if (inCode) {
      codeLines.push(line);
    } else {
      markdownLines.push(line);
    }
  }

  if (inCode) {
    flushCode();
  } else {
    flushMarkdown();
  }

  if (cells.length === 0) {
    cells.push(new vscode.NotebookCellData(vscode.NotebookCellKind.Code, '', 'javascript'));
  }

  return cells;
}

function parseFenceInfo(rawInfo) {
  const raw = rawInfo.trim();
  const body = raw.startsWith('{') && raw.includes('}')
    ? raw.slice(1, raw.indexOf('}'))
    : raw;
  const parts = body.trim().split(/\s+/g).filter(Boolean);
  const language = normalizeLanguage(parts[0] || 'plaintext');
  return {
    language,
    autorun: parts.some(part => part.toLowerCase() === 'autorun')
  };
}

function normalizeLanguage(language) {
  const normalized = language.replace(/^\./, '').toLowerCase();
  if (normalized === 'js') {
    return 'javascript';
  }
  return normalized || 'plaintext';
}

function serializeDebugNotebook(cells) {
  return cells.map(cell => {
    if (cell.kind === vscode.NotebookCellKind.Markup) {
      return cell.value;
    }

    const autorun = cell.metadata && cell.metadata.autorun === true ? ' autorun' : '';
    return `\`\`\`{${cell.languageId || 'plaintext'}${autorun}}\n${cell.value}\n\`\`\``;
  }).join('\n\n');
}

function describeEditor(editor) {
  return `viewColumn=${String(editor.viewColumn)} ${describeNotebook(editor.notebook)}`;
}

function describeNotebook(notebook) {
  return `type=${notebook.notebookType} uri=${describeUri(notebook.uri)} cells=${notebook.cellCount}`;
}

function describeCell(cell) {
  return [
    `index=${cell.index}`,
    `kind=${cell.kind}`,
    `language=${cell.document.languageId}`,
    `notebook=${describeUri(cell.notebook.uri)}`,
    `document=${describeUri(cell.document.uri)}`,
    `version=${cell.document.version}`
  ].join(' ');
}

function describeUri(uri) {
  return `${uri.toString()} {scheme=${uri.scheme} authority=${uri.authority || '<none>'} path=${uri.path}}`;
}

function describeTab(tab) {
  const uri = getTabUri(tab.input);
  return `${tab.label}[active=${tab.isActive} dirty=${tab.isDirty} preview=${tab.isPreview}] ${tab.input.constructor.name}${uri ? ` ${describeUri(uri)}` : ''}`;
}

function getTabUri(input) {
  if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputNotebook || input instanceof vscode.TabInputCustom) {
    return input.uri;
  }
  return undefined;
}

function log(message, ...args) {
  console.log(`${LOG_PREFIX} ${message}`, ...args);
}

function logError(message, ...args) {
  console.error(`${LOG_PREFIX} ${message}`, ...args);
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

module.exports = {
  activate,
  deactivate
};
