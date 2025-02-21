const vscode = require('vscode');
const axios = require('axios');
require('dotenv').config();

let terminal;

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
        console.log('Detecting errors for language:', languageId);
        console.log('Output to check:', output);
        
        const patterns = this.errorPatterns[languageId] || this.errorPatterns.javascript;
        for (const pattern of patterns) {
            const match = output.match(pattern);
            if (match) {
                console.log('Error detected:', match[0]);
                return {
                    message: match[0],
                    fullContext: output
                };
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
        const currentLine = errorLocation.line || editor.selection.active.line;
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
        
        if (!process.env.OPENAI_API_KEY) {
            console.error('OpenAI API key not found');
            vscode.window.showErrorMessage('OpenAI API key not found. Please add it to your .env file.');
        }
    }

    async simplifyError(errorMessage, context) {
        try {
            console.log('Attempting to simplify error:', errorMessage);
            console.log('Using context:', context);

            if (!process.env.OPENAI_API_KEY) {
                throw new Error('OpenAI API key not found');
            }

            const prompt = this.constructPrompt(errorMessage, context);
            console.log('Sending prompt to OpenAI:', prompt);

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
                temperature: 0.7,
                max_tokens: 1000
            }, {
                headers: {
                    'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            });

            console.log('OpenAI response:', response.data);

            if (!response.data.choices || !response.data.choices[0]) {
                throw new Error('Invalid response from OpenAI');
            }

            return response.data.choices[0].message.content;
        } catch (error) {
            console.error('Error calling OpenAI:', error);
            if (error.response) {
                console.error('OpenAI API error details:', error.response.data);
            }
            throw new Error(`Failed to simplify error: ${error.message}`);
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
        
        ${context.imports ? `IMPORTS/DEPENDENCIES:\n${context.imports}` : ''}
        
        Please provide a clear and concise explanation of the error, step-by-step solution, and prevention tips.`;
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
    constructor(context) {
        this.terminal = null;
        this.errorBuffer = '';
        this.detector = new ErrorDetector();
        this.decorator = new TerminalDecorator();
        this.writeEmitter = new vscode.EventEmitter();
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );
        this.context = context;
        this.context.subscriptions.push(this.statusBarItem);
        
        // Initialize status bar item
        this.statusBarItem.text = "$(bug) BugBuddy";
        this.statusBarItem.tooltip = "Click to analyze code";
        this.statusBarItem.command = 'bugbuddy.simplifyError';
        this.statusBarItem.show();
    }

    createTerminal() {
        console.log('Creating BugBuddy terminal');
        const pty = {
            onDidWrite: this.writeEmitter.event,
            open: () => {
                this.writeEmitter.fire('🐛 BugBuddy Terminal Active\r\n');
            },
            close: () => {
                this.writeEmitter.dispose();
            },
            handleInput: (data) => {
                this.writeEmitter.fire(data);
            }
        };

        this.terminal = vscode.window.createTerminal({
            name: 'BugBuddy',
            pty
        });

        return this.terminal;
    }

    checkForErrors(document) {
        console.log('Checking for errors...');
        if (!document) return;

        const text = document.getText();
        const errorResult = this.detector.detectError(
            text,
            document.languageId
        );

        if (errorResult) {
            console.log('Error detected:', errorResult);
            this.errorBuffer = errorResult.message; // Store just the error message
            this.showSimplifyButton();
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                this.decorator.highlightError(editor, editor.selection.active.line);
            }
        }
    }

    showSimplifyButton() {
        console.log('Showing simplify button');
        this.statusBarItem.text = "$(bug) Simplify Error";
        this.statusBarItem.command = 'bugbuddy.simplifyError';
        this.statusBarItem.show();
    }

    showSimplifiedError(originalError, simplifiedError) {
        if (!this.terminal) {
            this.createTerminal();
        }

        const output = `
🔍 Original Error:
${this.errorBuffer || 'No error message available'}

💡 Simplified Explanation:
${simplifiedError}

────────────────────────────────────
`;

        this.writeEmitter.fire(output.replace(/\n/g, '\r\n'));
        this.terminal.show(true);
    }

    dispose() {
        if (this.terminal) {
            this.terminal.dispose();
        }
        this.writeEmitter.dispose();
        this.statusBarItem.dispose();
    }
}

function activate(context) {
    console.log('Activating BugBuddy extension');
    
    try {
        terminal = new BugBuddyTerminal(context);
        const errorSimplifier = new ErrorSimplifier();
        const contextGatherer = new CodeContextGatherer();
        const customTerminal = terminal.createTerminal();
        
        // Register event listeners
        context.subscriptions.push(
            vscode.workspace.onDidChangeTextDocument(event => {
                console.log('Document changed');
                if (vscode.window.activeTextEditor) {
                    terminal.checkForErrors(event.document);
                }
            })
        );

        context.subscriptions.push(
            vscode.window.onDidChangeActiveTextEditor(editor => {
                console.log('Active editor changed');
                if (editor) {
                    terminal.checkForErrors(editor.document);
                }
            })
        );

        // Check for errors in the current document
        if (vscode.window.activeTextEditor) {
            terminal.checkForErrors(vscode.window.activeTextEditor.document);
        }

        // Register command
        let disposable = vscode.commands.registerCommand(
            'bugbuddy.simplifyError',
            async () => {
                console.log('Simplify Error command triggered');
                try {
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

                    // Show loading message
                    vscode.window.showInformationMessage('Analyzing error...');

                    const simplifiedError = await errorSimplifier.simplifyError(
                        terminal.errorBuffer || 'Error in selected code',
                        errorContext
                    );

                    terminal.showSimplifiedError(errorContext.code, simplifiedError);
                    customTerminal.show();
                } catch (error) {
                    console.error('Error in simplifyError command:', error);
                    vscode.window.showErrorMessage(`Error: ${error.message}`);
                }
            }
        );

        context.subscriptions.push(disposable);

        // Create diagnostic collection
        const diagnostics = vscode.languages.createDiagnosticCollection('bugbuddy');
        context.subscriptions.push(diagnostics);

        console.log('BugBuddy extension activated successfully');
    } catch (error) {
        console.error('BugBuddy activation error:', error);
        vscode.window.showErrorMessage('BugBuddy failed to activate: ' + error.message);
    }
}

function deactivate() {
    if (terminal) {
        terminal.dispose();
    }
}

module.exports = {
    activate,
    deactivate
};