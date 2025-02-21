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
        
        // Skip checking code in comments
        const commentFilter = (text) => {
            // Remove JavaScript/Java style comments
            if (languageId === 'javascript' || languageId === 'java') {
                text = text.replace(/\/\/.*$/gm, '');
                text = text.replace(/\/\*[\s\S]*?\*\//g, '');
            }
            // Remove Python style comments
            if (languageId === 'python') {
                text = text.replace(/#.*$/gm, '');
            }
            return text;
        };
        
        const filteredOutput = commentFilter(output);
        
        const patterns = this.errorPatterns[languageId] || this.errorPatterns.javascript;
        for (const pattern of patterns) {
            const match = filteredOutput.match(pattern);
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
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.detector = new ErrorDetector();
        this.contextGatherer = new CodeContextGatherer();
        
        if (!this.apiKey) {
            console.error('Gemini API key not found');
            vscode.window.showErrorMessage('Gemini API key not found. Please add it via the command.');
        }
    }

    async simplifyError(errorMessage, context) {
        try {
            console.log('Attempting to simplify error:', errorMessage);
            console.log('Using context:', context);

            if (!this.apiKey) {
                throw new Error('Gemini API key not found');
            }

            // Show progress notification
            const progressOptions = {
                location: vscode.ProgressLocation.Notification,
                title: 'Analyzing error...',
                cancellable: false
            };
            
            return await vscode.window.withProgress(progressOptions, async (progress) => {
                progress.report({ message: 'Connecting to Gemini API...' });
                
                const prompt = this.constructPrompt(errorMessage, context);
                console.log('Sending prompt to Gemini API');

                try {
                    // Gemini API endpoint
                    const response = await axios.post(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.0-pro:generateContent?key=${this.apiKey}`, {
                        contents: [
                            {
                                role: "user",
                                parts: [
                                    {
                                        text: prompt
                                    }
                                ]
                            }
                        ],
                        generationConfig: {
                            temperature: 0.7,
                            maxOutputTokens: 1000,
                        }
                    }, {
                        headers: {
                            'Content-Type': 'application/json'
                        }
                    });

                    progress.report({ message: 'Processing explanation...' });
                    console.log('Gemini API response received');

                    if (!response.data.candidates || !response.data.candidates[0]) {
                        throw new Error('Invalid response from Gemini API');
                    }

                    // Extract content from Gemini response
                    const content = response.data.candidates[0].content;
                    if (!content || !content.parts || !content.parts[0]) {
                        throw new Error('Invalid content structure in Gemini API response');
                    }

                    return content.parts[0].text;
                } catch (error) {
                    if (error.response) {
                        const { status, data } = error.response;
                        if (status === 401 || status === 403) {
                            throw new Error('Invalid Gemini API key. Please update your API key.');
                        } else if (status === 429) {
                            throw new Error('Gemini API rate limit exceeded. Please try again later.');
                        }
                        console.error('Gemini API error details:', data);
                    }
                    throw error;
                }
            });
        } catch (error) {
            console.error('Error calling Gemini API:', error);
            throw new Error(`Failed to simplify error: ${error.message}`);
        }
    }

    constructPrompt(errorMessage, context) {
        return `Please analyze this error as an expert programmer. Format your response in the following sections:
        1. 🔍 ERROR SUMMARY: Brief, clear explanation of what went wrong
        2. 💡 SOLUTION: Step-by-step fix
        3. 🔮 PREVENTION: How to prevent this error in the future

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
        if (!editor) return;
        
        try {
            const range = new vscode.Range(
                new vscode.Position(line, 0),
                new vscode.Position(line, editor.document.lineAt(line).text.length)
            );
            editor.setDecorations(this.decorationType, [range]);
        } catch (error) {
            console.error('Error highlighting text:', error);
            // Fail silently - decoration is not critical
        }
    }
    
    clearHighlights(editor) {
        if (editor) {
            editor.setDecorations(this.decorationType, []);
        }
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
        this.isErrorDetected = false;
        
        // Initialize status bar item
        this.resetStatusBar();
    }

    resetStatusBar() {
        this.statusBarItem.text = "$(bug) BugBuddy";
        this.statusBarItem.tooltip = "Click to analyze code";
        this.statusBarItem.command = 'bugbuddy.simplifyError';
        this.statusBarItem.show();
    }

    createTerminal() {
        console.log('Creating BugBuddy terminal');
        
        // Dispose existing terminal if any
        if (this.terminal) {
            try {
                this.terminal.dispose();
            } catch (e) {
                console.error('Error disposing terminal:', e);
            }
        }
        
        const pty = {
            onDidWrite: this.writeEmitter.event,
            open: () => {
                this.writeEmitter.fire('🐛 BugBuddy Terminal Active\r\n');
                this.writeEmitter.fire('Ready to analyze code errors\r\n\r\n');
            },
            close: () => {},
            handleInput: (data) => {
                // Echo back input
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
        
        // Clear previous highlights
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            this.decorator.clearHighlights(editor);
        }

        try {
            const text = document.getText();
            const errorResult = this.detector.detectError(
                text,
                document.languageId
            );

            if (errorResult) {
                console.log('Error detected:', errorResult);
                this.errorBuffer = errorResult.message; // Store just the error message
                this.isErrorDetected = true;
                this.showSimplifyButton();
                
                if (editor) {
                    // Try to find line number from error message based on language
                    let errorLine = editor.selection.active.line;
                    if (document.languageId === 'javascript') {
                        const lineMatch = errorResult.message.match(/line (\d+)/i);
                        if (lineMatch && lineMatch[1]) {
                            errorLine = parseInt(lineMatch[1], 10) - 1;
                        }
                    } else if (document.languageId === 'python') {
                        const lineMatch = errorResult.message.match(/line (\d+)/i);
                        if (lineMatch && lineMatch[1]) {
                            errorLine = parseInt(lineMatch[1], 10) - 1;
                        }
                    }
                    
                    this.decorator.highlightError(editor, errorLine);
                }
            } else {
                if (this.isErrorDetected) {
                    this.resetStatusBar();
                    this.isErrorDetected = false;
                }
            }
        } catch (error) {
            console.error('Error in checkForErrors:', error);
        }
    }

    showSimplifyButton() {
        console.log('Showing simplify button');
        this.statusBarItem.text = "$(bug) Simplify Error";
        this.statusBarItem.tooltip = "Click to get help with the detected error";
        this.statusBarItem.command = 'bugbuddy.simplifyError';
        this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
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
        this.decorator.clearHighlights(vscode.window.activeTextEditor);
    }
}

async function activate(context) {
    console.log('Activating BugBuddy extension');
    
    try {
        // Initialize secret storage
        const secretStorage = context.secrets;
        
        // Check if API key exists in secrets - update key name for Gemini
        let apiKey = await secretStorage.get('gemini-api-key');
        
        // If no Gemini API key in secrets, check for OpenAI key to migrate
        if (!apiKey) {
            // First check for old OpenAI key in secrets to migrate
            const oldKey = await secretStorage.get('openai-api-key');
            if (oldKey) {
                console.log('Found OpenAI key, will prompt for Gemini key migration');
                vscode.window.showInformationMessage('BugBuddy now uses Gemini API. Please update your API key.', 'Update Now')
                    .then(selection => {
                        if (selection === 'Update Now') {
                            vscode.commands.executeCommand('bugbuddy.updateApiKey');
                        }
                    });
            }
            // Then check .env as fallback (during transition)
            else if (process.env.GEMINI_API_KEY) {
                apiKey = process.env.GEMINI_API_KEY;
                // Save to secrets for future use
                await secretStorage.store('gemini-api-key', apiKey);
                console.log('API key migrated from .env to secret storage');
            }
        }
        
        // Initialize components
        terminal = new BugBuddyTerminal(context);
        const errorSimplifier = new ErrorSimplifier(apiKey);
        const contextGatherer = new CodeContextGatherer();
        const customTerminal = terminal.createTerminal();
        
        // Register API key management command
        let updateKeyCommand = vscode.commands.registerCommand('bugbuddy.updateApiKey', async () => {
            const enteredKey = await vscode.window.showInputBox({
                prompt: 'Enter your Gemini API key',
                placeHolder: 'AIza...',
                password: true
            });
            
            if (enteredKey) {
                await secretStorage.store('gemini-api-key', enteredKey);
                vscode.window.showInformationMessage('Gemini API key updated successfully');
                // Update the current instance
                errorSimplifier.apiKey = enteredKey;
            }
        });
        
        context.subscriptions.push(updateKeyCommand);
        
        // Register event listeners with debouncing
        let documentChangeTimeout = null;
        context.subscriptions.push(
            vscode.workspace.onDidChangeTextDocument(event => {
                if (documentChangeTimeout) {
                    clearTimeout(documentChangeTimeout);
                }
                
                documentChangeTimeout = setTimeout(() => {
                    if (vscode.window.activeTextEditor) {
                        terminal.checkForErrors(event.document);
                    }
                }, 500); // 500ms debounce
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

        // Register simplify error command
        let disposable = vscode.commands.registerCommand(
            'bugbuddy.simplifyError',
            async () => {
                console.log('Simplify Error command triggered');
                try {
                    // Check for API key first
                    if (!errorSimplifier.apiKey) {
                        const shouldConfigure = await vscode.window.showInformationMessage(
                            'Gemini API key is required to analyze errors.', 
                            'Configure API Key'
                        );
                        
                        if (shouldConfigure === 'Configure API Key') {
                            vscode.commands.executeCommand('bugbuddy.updateApiKey');
                            return;
                        }
                        return;
                    }
                    
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

                    try {
                        const simplifiedError = await errorSimplifier.simplifyError(
                            terminal.errorBuffer || 'Error in selected code',
                            errorContext
                        );

                        terminal.showSimplifiedError(errorContext.code, simplifiedError);
                        customTerminal.show();
                    } catch (error) {
                        if (error.message.includes('API key')) {
                            const shouldUpdate = await vscode.window.showErrorMessage(
                                `Error: ${error.message}`, 
                                'Update API Key'
                            );
                            
                            if (shouldUpdate === 'Update API Key') {
                                vscode.commands.executeCommand('bugbuddy.updateApiKey');
                            }
                        } else {
                            vscode.window.showErrorMessage(`Error: ${error.message}`);
                        }
                    }
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


