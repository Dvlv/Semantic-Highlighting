/** Adapted from  vscode-color-identifiers-mode by mnespor https://github.com/mnespor/vscode-color-identifiers-mode */

import * as vscode from 'vscode';


/**
 * Tokens in a file are represented as an array of integers. The position of each token is expressed relative to
 * the token before it, because most tokens remain stable relative to each other when edits are made in a file.
 *
 * ---
 * In short, each token takes 5 integers to represent, so a specific token `i` in the file consists of the following array indices:
 *  - at index `5*i`   - `deltaLine`: token line number, relative to the previous token
 *  - at index `5*i+1` - `deltaStart`: token start character, relative to the previous token (relative to 0 or the previous token's start if they are on the same line)
 *  - at index `5*i+2` - `length`: the length of the token. A token cannot be multiline.
 *  - at index `5*i+3` - `tokenType`: will be looked up in `SemanticTokensLegend.tokenTypes`. We currently ask that `tokenType` < 65536.
 *  - at index `5*i+4` - `tokenModifiers`: each set bit will be looked up in `SemanticTokensLegend.tokenModifiers`
 *
 * ---
 * ### How to encode tokens
 *
 * Here is an example for encoding a file with 3 tokens in a uint32 array:
 * ```
 *    { line: 2, startChar:  5, length: 3, tokenType: "property",  tokenModifiers: ["private", "static"] },
 *    { line: 2, startChar: 10, length: 4, tokenType: "type",      tokenModifiers: [] },
 *    { line: 5, startChar:  2, length: 7, tokenType: "class",     tokenModifiers: [] }
 * ```
 *
 * 1. First of all, a legend must be devised. This legend must be provided up-front and capture all possible token types.
 * For this example, we will choose the following legend which must be passed in when registering the provider:
 * ```
 *    tokenTypes: ['property', 'type', 'class'],
 *    tokenModifiers: ['private', 'static']
 * ```
 *
 * 2. The first transformation step is to encode `tokenType` and `tokenModifiers` as integers using the legend. Token types are looked
 * up by index, so a `tokenType` value of `1` means `tokenTypes[1]`. Multiple token modifiers can be set by using bit flags,
 * so a `tokenModifier` value of `3` is first viewed as binary `0b00000011`, which means `[tokenModifiers[0], tokenModifiers[1]]` because
 * bits 0 and 1 are set. Using this legend, the tokens now are:
 * ```
 *    { line: 2, startChar:  5, length: 3, tokenType: 0, tokenModifiers: 3 },
 *    { line: 2, startChar: 10, length: 4, tokenType: 1, tokenModifiers: 0 },
 *    { line: 5, startChar:  2, length: 7, tokenType: 2, tokenModifiers: 0 }
 * ```
 *
 * 3. The next step is to represent each token relative to the previous token in the file. In this case, the second token
 * is on the same line as the first token, so the `startChar` of the second token is made relative to the `startChar`
 * of the first token, so it will be `10 - 5`. The third token is on a different line than the second token, so the
 * `startChar` of the third token will not be altered:
 * ```
 *    { deltaLine: 2, deltaStartChar: 5, length: 3, tokenType: 0, tokenModifiers: 3 },
 *    { deltaLine: 0, deltaStartChar: 5, length: 4, tokenType: 1, tokenModifiers: 0 },
 *    { deltaLine: 3, deltaStartChar: 2, length: 7, tokenType: 2, tokenModifiers: 0 }
 * ```
 *
 * 4. Finally, the last step is to inline each of the 5 fields for a token in a single array, which is a memory friendly representation:
 * ```
 *    // 1st token,  2nd token,  3rd token
 *    [  2,5,3,0,3,  0,5,4,1,0,  3,2,7,2,0 ]
 * ```
 *
 * @see [SemanticTokensBuilder](#SemanticTokensBuilder) for a helper to encode tokens as integers.
 * *NOTE*: When doing edits, it is possible that multiple edits occur until VS Code decides to invoke the semantic tokens provider.
 * *NOTE*: If the provider cannot temporarily compute semantic tokens, it can indicate this by throwing an error with the message 'Busy'.
 */
export function rangesByName(data: vscode.SemanticTokens, legend: vscode.SemanticTokensLegend, editor: vscode.TextEditor, highlightGlobals: boolean, highlightClasses: boolean): Map<string, vscode.Range[]> {
    const accumulatorParam: Map<string, vscode.Range[]> = new Map();
    const accumulatorVar: Map<string, vscode.Range[]> = new Map();
    const accumulatorWithDec: Map<string, boolean> = new Map();
    const recordSize = 5;
    let line = 0;
    let column = 0;

    for (let i = 0; i < data.data.length; i += recordSize) {
        const [deltaLine, deltaColumn, length, kindIndex, modifierIndex] = data.data.slice(i, i + recordSize);
        column = deltaLine === 0 ? column : 0;
        line += deltaLine;
        column += deltaColumn;
        const range = new vscode.Range(line, column, line, column + length);
        const name = editor.document.getText(range);
        const kind = legend.tokenTypes[kindIndex];
        const modifiers = legend.tokenModifiers.filter((_, index) => (modifierIndex & (1 << index)) !== 0);
        if (highlightGlobals || !modifiers.includes('global') && name.length > 2) {
            if ('variable' === kind) {
                if (accumulatorVar.has(name)) {
                    accumulatorVar.get(name)!.push(range);
                } else {
                    accumulatorVar.set(name, [range]);
                }
            }
            else if (kind === 'parameter' && !modifiers.includes('label')) {
                // Check for declaration to not highlight labels in python since the modifier
                // label is not declared by pylance.
                // See https://github.com/microsoft/pylance-release/issues/2196
                if (!accumulatorWithDec.has(name)) {
                    accumulatorWithDec.set(name, false);
                }
                if (modifiers.includes('declaration')) {
                    accumulatorWithDec.set(name, true);
                }

                if (accumulatorParam.has(name)) {
                    accumulatorParam.get(name)!.push(range);
                } else {
                    accumulatorParam.set(name, [range]);
                }
            }
        }

        if (highlightClasses && kind === 'class') {
            if (accumulatorVar.has(name)) {
                accumulatorVar.get(name)!.push(range);
            } else {
                accumulatorVar.set(name, [range]);
            }
        }
    }

    // The cpp language server does not implement the declaration modifier
    // hence we colorize everything
    if (editor.document.languageId === "cpp") {
        for (let [name, isDeclared] of accumulatorWithDec) {
            accumulatorWithDec.set(name, true);
        }
    }
    for (let [name, isDeclared] of accumulatorWithDec) {
        if (!isDeclared) {
            accumulatorParam.delete(name);
        }
        else {
            if (accumulatorVar.has(name)) {
                accumulatorVar.set(name,
                    accumulatorVar.get(name)!.concat(accumulatorParam.get(name)!));
            } else {
                accumulatorVar.set(name, accumulatorParam.get(name)!);
            }
        }
    }
    return accumulatorVar;
}
