const ts = require('typescript');
const fs = require("fs");
function generateDeclaration() {
    const configPath = ts.findConfigFile('./', ts.sys.fileExists, 'tsconfig.json');
    const config = ts.readConfigFile(configPath, ts.sys.readFile).config;
    const parseConfigHost = {
        fileExists: ts.sys.fileExists,
        readFile: ts.sys.readFile,
        readDirectory: ts.sys.readDirectory,
        useCaseSensitiveFileNames: true
    };
    const parsed = ts.parseJsonConfigFileContent(config, parseConfigHost, './');
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    program.emit();
}

function fixDeclaration(declarationName) {
    const program = ts.createProgram([declarationName], {
        noEmit: true
    });
    var checker = program.getTypeChecker();

    const diagnostics = ts.getPreEmitDiagnostics(program);

    diagnostics.forEach(diagnostic => {
        if (diagnostic.file) {
            const {
                line,
                character
            } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
            const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
            console.log(`${diagnostic.file.fileName} (${line + 1},${character + 1}): ${message}`);
        }
        else {
            console.log(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
        }
    });
    
    let interfaces = collectInterfaces(program.getSourceFile('./ace.d.ts'));

    /**
     * @param {ts.TransformationContext} context
     * @return {function(*): *}
     */
    function transformer(context) {
        return (sourceFile) => {
            function visit(node) {
                let updatedNode = node;
                if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
                    if (interfaces[node.name.text]) {
                        if (node.body && ts.isModuleBlock(node.body)) {
                            const newBody = ts.factory.createModuleBlock(
                                node.body.statements.concat(interfaces[node.name.text])
                            );

                            updatedNode = ts.factory.updateModuleDeclaration(
                                node,
                                node.modifiers,
                                node.name,
                                newBody
                            );

                        }
                    } else if (node.name.text.endsWith("/config") || node.name.text.endsWith("textarea")) {//TODO: should be better way to do this
                        if (node.body && ts.isModuleBlock(node.body)) {
                            const newBody = ts.factory.createModuleBlock(
                                node.body.statements.filter(statement => {
                                    const exportsStatement = ts.isVariableStatement(statement) && statement.declarationList.declarations[0].name.getText() == "_exports";
                                    return exportsStatement || ts.isExportAssignment(statement) || ts.isImportEqualsDeclaration(statement);
                                })
                            );
                            updatedNode = ts.factory.updateModuleDeclaration(
                                node,
                                node.modifiers,
                                node.name,
                                newBody
                            );

                        }
                    }
                } else
                if (ts.isInterfaceDeclaration(node) && node.heritageClauses) {
                    for (const clause of node.heritageClauses) {
                        if (clause.token === ts.SyntaxKind.ExtendsKeyword && clause.types.length === 0) {
                            // Remove the extends clause if it's empty
                            return context.factory.updateInterfaceDeclaration(
                                node,
                                node.modifiers,
                                node.name,
                                node.typeParameters,
                                [],
                                node.members
                            );
                        }
                    }
                } else if (ts.isClassDeclaration(node) && node.heritageClauses) {
                    let updatedHeritageClauses = [];
                    for (let i = 0; i < node.heritageClauses.length; i++) {
                        let clause = node.heritageClauses[i];
                        if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
                            const updatedTypes = clause.types.filter(type => {
                                if (diagnostics.some(//TODO: 
                                    diagnostic => [2507, 1174].includes(diagnostic.code) && diagnostic.file
                                        === sourceFile && diagnostic.start >= type.pos && type.end >= diagnostic.start
                                        + diagnostic.length)) return false;
                                const symbol = checker.getSymbolAtLocation(type.expression);
                                if (symbol) {
                                    const declaredType = checker.getDeclaredTypeOfSymbol(symbol);

                                    return declaredType.flags !== ts.TypeFlags.Undefined
                                        && declaredType["intrinsicName"] !== "error";
                                }
                                return true;  // keep the type if the symbol can't be resolved
                            });
                            if (updatedTypes.length === 0) {
                                continue;
                            }
                            var updatedHeritageClause = clause;
                            if (updatedTypes.length !== clause.types.length) {
                                updatedHeritageClause = context.factory.createHeritageClause(
                                    ts.SyntaxKind.ExtendsKeyword, updatedTypes);
                            }
                        }
                        if (updatedHeritageClause) {
                            updatedHeritageClauses.push(updatedHeritageClause);
                        }
                        else {
                            updatedHeritageClauses.push(clause);
                        }
                    }
                    return context.factory.updateClassDeclaration(node, node.modifiers, node.name, node.typeParameters,
                        updatedHeritageClauses, node.members
                    );
                }
                return ts.visitEachChild(updatedNode, visit, context);
            }
            return ts.visitNode(sourceFile, visit);
        };
    }
    const sourceCode = program.getSourceFiles().filter(f => f.fileName.includes(declarationName));
    const result = ts.transform(sourceCode, [transformer]);

    const printer = ts.createPrinter();
    result.transformed.forEach(transformedFile => {
        const output = printer.printFile(transformedFile);
        fs.writeFileSync(declarationName, output);
    });

    result.dispose();
}

function collectInterfaces(sourceFile) {
    const result = {};
    const printer = ts.createPrinter();

    function visit(node) {
        if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
            let nodes= [];
            if (node.body && ts.isModuleBlock(node.body)) {
                ts.forEachChild(node.body, (child) => {
                    if (ts.isInterfaceDeclaration(child))
                        nodes.push(child);
                });
            }
            if (nodes.length > 0) {
                const interfaceStrings = nodes.map(interfaceNode => printer.printNode(ts.EmitHint.Unspecified, interfaceNode, sourceFile));
                
                let concatenatedInterfaceStrings = interfaceStrings.join('\n\n');
                //TODO:
                let identifiers = concatenatedInterfaceStrings.match(/Ace\.[\w]+<?/g);
                if (identifiers && identifiers.length > 0) {
                    identifiers = [...new Set(identifiers)];
                    let importAlias = '';
                    identifiers.forEach(identifier => {
                            let typeName = identifier.replace("Ace.", "");
                            
                            if (typeName.includes("<")) {
                                typeName = typeName + "T>";
                            }
                        importAlias += "type " + typeName + " = import(\"../ace\").Ace." + typeName + ";\n\n";
                    });
                    concatenatedInterfaceStrings = "namespace Ace {"+ importAlias + "}" + concatenatedInterfaceStrings;
                }
               
                const newSourceFile = ts.createSourceFile('temp.d.ts', concatenatedInterfaceStrings, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
                nodes = newSourceFile.statements;
            }
            result[node.name.text.replace("./", "ace-code/")] = nodes;
        }
        ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    
    return result;
}

function fixImports(inputFileName, outputFileName) {
    fs.readFile(inputFileName, 'utf8', (err, data) => {
        if (err) {
            console.error('Error reading the file:', err);
            return;
        }

        // Replace the content
        let updatedContent = data.replaceAll(/(declare module ")/g, "$1ace-code/");
        updatedContent = updatedContent.replaceAll(/(import\(")(ace"\).Ace)/g, "$1../$2");
        updatedContent = updatedContent.replaceAll(/(require\(")/g, "$1ace-code/");
        updatedContent = updatedContent.replaceAll(/(import\(")(?=[^\.])/g, "$1ace-code/");
        updatedContent = updatedContent.replaceAll("../../", "../");
        updatedContent = updatedContent.replaceAll("ace-code/src/ace", "ace-code");
        // Write to a new file
        fs.writeFile(outputFileName, updatedContent, 'utf8', (err) => {
            if (err) {
                console.error('Error writing to file:', err);
            } else {
                console.log('File processing complete, saved as', outputFileName);
                fixDeclaration(outputFileName);
            }
        });
    });
}
generateDeclaration();
fixImports('types/index.d.ts', 'types/index.d.ts');



