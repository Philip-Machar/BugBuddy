// extension.js
const vscode = require('vscode');
const axios = require('axios');
require('dotenv').config();

class ErrorDetector {
  constructor() {
    this.errorPatterns = {
      javascript: [
        /TypeError:.*$/m,
        /ReferenceError:.*$/m,
        /SyntaxError:.*$/m,
        /Error:.*$/m
      ],
      python: [
        /Traceback \(most recent call last\):[\s\S]*?(?=\n\n|\Z)/,
        /(?:.*Error:.*$)/m
      ],
      java: [
        /Exception in thread.*$/m,
        /.*Exception:.*$/m
      ]
    };
  }

  detectError(output, languageId) {
    const patterns = this.errorPatterns[languageId] || this.errorPatterns.javascript;
    for (const pattern of patterns) {
      const match = output.match(pattern);
      if (match) {
        return match[0];
      }
    }
    return null;
  }
}

class CodeContextGatherer {
  constructor() {
    this.config = vscode.workspace.getConfiguration('bugbuddy');
  }

  async getContext(errorLocation) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return null;

    const document = editor.document;
    const currentLine = errorLocation.line;
    const contextLines = this.config.get('contextLines', 5);
    
    const startLine = Math.max(0, currentLine - contextLines);
    const endLine = Math.min(document.lineCount - 1, currentLine + contextLines);
    
    const contextRange = new vscode.Range(
      new vscode.Position(startLine, 0),
      new vscode.Position(endLine, document.lineAt(endLine).text.length)
    );

    const context = {
      code: document.getText(contextRange),
      fileName: document.fileName,
      language: document.languageId,
      errorLine: currentLine + 1,
      startLine: startLine + 1,
      endLine: endLine + 1,
      fullFileContent: document.getText()
    };

    // Add imports and dependencies context
    if (document.languageId === 'javascript' || document.languageId === 'typescript') {
      context.imports = this.extractImports(context.fullFileContent);
    }

    return context;
  }

  extractImports(content) {
    const importPattern = /^import.*from.*$|^const.*require\(.*\).*$/gm;
    return (content.match(importPattern) || []).join('\n');
  }
}

class ErrorSimplifier {
  constructor() {
    this.detector = new ErrorDetector();
    this.contextGatherer = new CodeContextGatherer();
  }

  async simplifyError(errorMessage, context) {
    try {
      const prompt = this.constructPrompt(errorMessage, context);
      const response = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: 'gpt-4',
        messages: [{
          role: 'system',
          content: `You are an expert programmer helping to explain errors. 
                    Format your response in the following sections:
                    1. 🔍 ERROR SUMMARY: Brief, clear explanation of what went wrong
                    2. 💡 SOLUTION: Step-by-step fix
                    3. 🔮 PREVENTION: How to prevent this error in the future`
        }, {
          role: 'user',
          content: prompt
        }],
        temperature: 0.7
      }, {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      });

      return response.data.choices[0].message.content;
    } catch (error) {
      console.error('Error calling OpenAI:', error);
      return 'Failed to simplify error. Please try again.';
    }
  }

  constructPrompt(errorMessage, context) {
    return `Please analyze this error:

    ERROR MESSAGE:
    ${errorMessage}

    CODE CONTEXT:
    Language: ${context.language}
    File: ${context.fileName}
    Error Line: ${context.errorLine}
    
    RELEVANT CODE:
    \`\`\`${context.language}
    ${context.code}
    \`\`\`
    
    ${context.imports ? `IMPORTS/DEPENDENCIES:\n${context.imports}` : ''}`;
  }
}

class TerminalDecorator {
  constructor() {
    this.decorationType = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor('editor.findMatchBackground'),
      after: {
        contentText: ' 🐛',
        margin: '0 0 0 1em'
      }
    });
  }

  highlightError(editor, line) {
    const range = new vscode.Range(
      new vscode.Position(line, 0),
      new vscode.Position(line, editor.document.lineAt(line).text.length)
    );
    editor.setDecorations(this.decorationType, [range]);
  }
}

class BugBuddyTerminal {
  constructor() {
    this.terminal = null;
    this.writeEmitter = new vscode.EventEmitter();
    this.errorBuffer = '';
    this.detector = new ErrorDetector();
    this.decorator = new TerminalDecorator();
  }

  createTerminal() {
    const pty = {
      onDidWrite: this.writeEmitter.event,
      open: () => {},
      close: () => {},
      handleInput: (data) => {
        this.errorBuffer += data;
        this.checkForErrors();
      }
    };

    this.terminal = vscode.window.createTerminal({ 
      name: 'BugBuddy',
      pty 
    });
    
    return this.terminal;
  }

  checkForErrors() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const error = this.detector.detectError(
      this.errorBuffer,
      editor.document.languageId
    );

    if (error) {
      this.showSimplifyButton();
      this.decorator.highlightError(editor, editor.selection.active.line);
    }
  }

  showSimplifyButton() {
    const button = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    button.text = "$(bug) Simplify Error";
    button.command = 'bugbuddy.simplifyError';
    button.show();

    // Auto-hide after 10 seconds
    setTimeout(() => button.hide(), 10000);
  }

  showSimplifiedError(originalError, simplifiedError) {
    const formattedError = `
🐛 BugBuddy Analysis:
──────────────────────
${simplifiedError}
──────────────────────
`;
    this.writeEmitter.fire(formattedError);
  }
}

function activate(context) {
  const terminal = new BugBuddyTerminal();
  const errorSimplifier = new ErrorSimplifier();
  const contextGatherer = new CodeContextGatherer();

  let disposable = vscode.commands.registerCommand(
    'bugbuddy.simplifyError',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('No active editor');
        return;
      }

      const errorContext = await contextGatherer.getContext({
        line: editor.selection.active.line
      });
      
      if (!errorContext) {
        vscode.window.showErrorMessage('Could not gather code context');
        return;
      }

      const customTerminal = terminal.createTerminal();
      const simplifiedError = await errorSimplifier.simplifyError(
        'Error in selected code',
        errorContext
      );

      terminal.showSimplifiedError(errorContext.code, simplifiedError);
      customTerminal.show();
    }
  );

  context.subscriptions.push(disposable);
}

exports.activate = activate;

function deactivate() {}

exports.deactivate = deactivate;