import { declare } from "@babel/helper-plugin-utils";
import { isIdentifier, isObjectExpression, isObjectProperty, isStringLiteral, } from "@babel/types";
import { parse } from '@formatjs/icu-messageformat-parser';
import { isArgumentElement, isDateElement, isDateTimeSkeleton, isLiteralElement, isNumberElement, isNumberSkeleton, isPoundElement, isSelectElement, isTagElement, isTimeElement, } from '@formatjs/icu-messageformat-parser/types.js';
const HELPERS_MAP = {
    0: "__interpolate",
    1: "__interpolate",
    2: "__number",
    3: "__date",
    4: "__time",
    5: "__select",
    6: "__plural",
    7: "__interpolate",
    8: "__interpolate", // This should not happen
};
const PLURAL_ABBREVIATIONS = {
    zero: 'z',
    one: 'o',
    two: 't',
    few: 'f',
    many: 'm',
    other: 'h'
};
export default function build(runtimeImportPath = "precompile-intl-runtime") {
    return declare(({ types: t, assertVersion }, options) => {
        assertVersion("^7.0");
        let usedHelpers = new Set();
        let currentFunctionParams = new Set();
        let pluralsStack = [];
        function normalizePluralKey(key) {
            key = key.trim();
            let match = key.match(/^=(\d+)/);
            if (match)
                return parseInt(match[1], 10);
            return PLURAL_ABBREVIATIONS[key] || key;
        }
        function normalizeKey(key) {
            key = key.trim();
            let match = key.match(/^=(\d)/);
            if (match)
                return parseInt(match[1], 10);
            return key;
        }
        function buildCallExpression(entry) {
            if (isLiteralElement(entry))
                throw new Error('Literal elements not supported!');
            if (isTagElement(entry))
                throw new Error('Tag elements not supported!');
            if (isPoundElement(entry))
                throw new Error('Pound elements not supported!');
            if (isNumberElement(entry)) {
                return buildNumberCallExpression(entry);
            }
            if (isDateElement(entry) || isTimeElement(entry)) {
                return buildDateOrTimeCallExpression(entry);
            }
            if (isArgumentElement(entry)) {
                return buildInterpolateCallExpression(entry);
            }
            if (isSelectElement(entry)) {
                return buildSelectCallExpression(entry);
            }
            return buildPluralCallExpression(entry);
        }
        function buildNumberCallExpression(entry) {
            usedHelpers.add(HELPERS_MAP[entry.type]);
            let callArgs = [];
            if (isNumberSkeleton(entry.style) && entry.style.parsedOptions.scale) {
                callArgs.push(t.binaryExpression("/", t.identifier(entry.value), t.numericLiteral(entry.style.parsedOptions.scale)));
                delete entry.style.parsedOptions.scale;
            }
            else {
                callArgs.push(t.identifier(entry.value));
            }
            currentFunctionParams.add(entry.value);
            if (isNumberSkeleton(entry.style)) {
                if (Object.keys(entry.style.parsedOptions).length > 0) {
                    // TODO: Being a compiler gives us the chance to be better at some things than other libraries
                    // For instance, when using `{style: 'unit', unit: XXXXX}` unit can only be one of a known list of units
                    // (see https://stackoverflow.com/questions/68035616/invalid-unit-argument-for-intl-numberformat-with-electric-units-volt-joule)
                    // Any unit but those will throw a runtime error, but we could error or at least show a warning to the user
                    // when invalid. P.e. a common mistake could be to use `unit: 'km'` (wrong) instead of the correct (`unit: 'kilometer'`).
                    let keys = Object.keys(entry.style.parsedOptions);
                    let options = t.objectExpression(keys.map(key => {
                        if (!isNumberSkeleton(entry.style))
                            throw new Error('The entry should have had a number skeleton');
                        let val = entry.style.parsedOptions[key];
                        return t.objectProperty(t.identifier(key), typeof val === "number"
                            ? t.numericLiteral(val)
                            : typeof val === "boolean"
                                ? t.booleanLiteral(val)
                                : t.stringLiteral(val));
                    }));
                    callArgs.push(options);
                }
            }
            else if (typeof entry.style === 'string') {
                callArgs.push(t.stringLiteral(entry.style));
            }
            return t.callExpression(t.identifier('__number'), callArgs);
        }
        function buildDateOrTimeCallExpression(entry) {
            let fnName = HELPERS_MAP[entry.type];
            usedHelpers.add(fnName);
            let callArgs = [t.identifier(entry.value)];
            currentFunctionParams.add(entry.value);
            // if (isDateTimeSkeleton(entry.style)) throw new Error('Datetime skeletons not supported yet');
            if (typeof entry.style === "string") {
                callArgs.push(t.stringLiteral(entry.style));
            }
            else if (isDateTimeSkeleton(entry.style)) {
                if (Object.keys(entry.style.parsedOptions).length > 0) {
                    let keys = Object.keys(entry.style.parsedOptions);
                    let options = t.objectExpression(keys.map(key => {
                        if (!isDateTimeSkeleton(entry.style))
                            throw new Error('The entry should have had a number skeleton');
                        let val = entry.style.parsedOptions[key];
                        return t.objectProperty(t.identifier(key), typeof val === "string"
                            ? t.stringLiteral(val)
                            : t.booleanLiteral(val));
                    }));
                    callArgs.push(options);
                }
            }
            return t.callExpression(t.identifier(fnName), callArgs);
        }
        function buildInterpolateCallExpression(entry) {
            let fnName = HELPERS_MAP[entry.type];
            usedHelpers.add(fnName);
            currentFunctionParams.add(entry.value);
            return t.callExpression(t.identifier(fnName), [t.identifier(entry.value)]);
        }
        function buildPluralCallExpression(entry) {
            let fnName = HELPERS_MAP[entry.type];
            pluralsStack.push(entry);
            usedHelpers.add(entry.offset !== 0 ? '__offsetPlural' : '__plural');
            let options = t.objectExpression(Object.keys(entry.options).map(key => {
                let objValueAST = entry.options[key].value;
                let objValue;
                if (objValueAST.length === 1 && objValueAST[0].type === 0) {
                    objValue = t.stringLiteral(objValueAST[0].value);
                }
                else {
                    objValue = objValueAST.length === 1 ? buildCallExpression(objValueAST[0]) : buildTemplateLiteral(objValueAST);
                }
                let normalizedKey = normalizePluralKey(key);
                return t.objectProperty(typeof normalizedKey === "number"
                    ? t.numericLiteral(normalizedKey)
                    : t.identifier(normalizedKey), objValue);
            }));
            pluralsStack.pop();
            currentFunctionParams.add(entry.value);
            if (entry.offset !== 0) {
                return t.callExpression(t.identifier("__offsetPlural"), [t.identifier(entry.value), t.numericLiteral(entry.offset), options]);
            }
            else {
                return t.callExpression(t.identifier(fnName), [t.identifier(entry.value), options]);
            }
        }
        function buildSelectCallExpression(entry) {
            let fnName = HELPERS_MAP[entry.type];
            usedHelpers.add(fnName);
            entry.options;
            let options = t.objectExpression(Object.keys(entry.options).map(key => {
                let objValueAST = entry.options[key].value;
                let objValue;
                if (objValueAST.length === 1 && objValueAST[0].type === 0) {
                    objValue = t.stringLiteral(objValueAST[0].value);
                }
                else {
                    objValue = objValueAST.length === 1 ? buildCallExpression(objValueAST[0]) : buildTemplateLiteral(objValueAST);
                }
                let normalizedKey = normalizeKey(key);
                return t.objectProperty(typeof normalizedKey === "number" ? t.numericLiteral(normalizedKey) : t.identifier(normalizedKey), objValue);
            }));
            currentFunctionParams.add(entry.value);
            return t.callExpression(t.identifier(fnName), [t.identifier(entry.value), options]);
        }
        function buildTemplateLiteral(ast) {
            let quasis = [];
            let expressions = [];
            for (let i = 0; i < ast.length; i++) {
                let entry = ast[i];
                switch (entry.type) {
                    case 0: // literal
                        quasis.push(t.templateElement(
                        // { value: entry.value, raw: entry.value }, this is not valid anymore?
                        { cooked: entry.value, raw: entry.value }, i === ast.length - 1 // tail
                        ));
                        break;
                    case 1: // intepolation
                        expressions.push(buildCallExpression(entry));
                        currentFunctionParams.add(entry.value);
                        if (i === 0)
                            quasis.push(t.templateElement({ cooked: '', raw: '' }, false));
                        break;
                    case 2: // Number format
                        expressions.push(buildCallExpression(entry));
                        currentFunctionParams.add(entry.value);
                        break;
                    case 3: // Date format
                        expressions.push(buildCallExpression(entry));
                        currentFunctionParams.add(entry.value);
                        break;
                    case 4: // Time format
                        expressions.push(buildCallExpression(entry));
                        currentFunctionParams.add(entry.value);
                        break;
                    case 5: // select
                        expressions.push(buildCallExpression(entry));
                        break;
                    case 6: // plural
                        expressions.push(buildCallExpression(entry));
                        break;
                    case 7: // # interpolation
                        let lastPlural = pluralsStack[pluralsStack.length - 1];
                        if (lastPlural.offset !== null && lastPlural.offset !== 0) {
                            expressions.push(t.binaryExpression("-", t.identifier(lastPlural.value), t.numericLiteral(lastPlural.offset)));
                        }
                        else {
                            expressions.push(t.identifier(lastPlural.value));
                        }
                        if (i === 0)
                            quasis.push(t.templateElement({ cooked: '', raw: '' }, false));
                        break;
                    default:
                        debugger;
                }
                if (i === ast.length - 1 && entry.type !== 0) {
                    quasis.push(t.templateElement({ cooked: '', raw: '' }, true));
                }
            }
            if (quasis.length === expressions.length && quasis.length === 0) {
                return t.stringLiteral(''); // If there's no data, return an empty string. No need to use backquotes.
            }
            // If the number of quasis must be one more than the number of expressions (because expressions go
            // in between). If that's not the case it means we need an empty string as first quasis.
            while (quasis.length <= expressions.length) {
                quasis.unshift(t.templateElement({ cooked: '', raw: '' }, false));
            }
            return t.templateLiteral(quasis, expressions);
        }
        function buildFunction(ast) {
            currentFunctionParams = new Set();
            pluralsStack = [];
            let body = ast.length === 1 ? buildCallExpression(ast[0]) : buildTemplateLiteral(ast);
            if (Array.from(currentFunctionParams).length === 0) {
                return body;
            }
            return t.arrowFunctionExpression(Array.from(currentFunctionParams).sort().map(p => t.identifier(p)), body);
        }
        function flattenObjectProperties(object, propsArray, currentPrefix) {
            return object.properties.forEach(op => {
                if (!isObjectProperty(op))
                    throw new Error('Exported objects can only contain regular properties');
                if (!isStringLiteral(op.key) && !isIdentifier(op.key))
                    throw new Error('Object keys for translations can only contain strings or identifiers');
                let name = isStringLiteral(op.key) ? op.key.value : op.key.name;
                name = currentPrefix ? currentPrefix + '.' + name : name;
                if (t.isObjectExpression(op.value)) {
                    flattenObjectProperties(op.value, propsArray, name);
                }
                else {
                    let key = (isStringLiteral(op.key) || !!currentPrefix) ? t.stringLiteral(name) : t.identifier(name);
                    propsArray.push([key, op.value]);
                }
            });
        }
        return {
            name: "precompile-intl",
            visitor: {
                Program: {
                    enter() {
                        usedHelpers = new Set();
                    },
                    exit(path) {
                        if (usedHelpers.size > 0) {
                            let importDeclaration = t.importDeclaration(Array.from(usedHelpers).sort().map(name => t.importSpecifier(t.identifier(name), t.identifier(name))), t.stringLiteral(runtimeImportPath));
                            path.unshiftContainer("body", importDeclaration);
                        }
                    }
                },
                ObjectProperty({ node }) {
                    if (t.isStringLiteral(node.value)) {
                        let icuAST = parse(node.value.value, { ignoreTag: true });
                        if (icuAST.length === 1 && icuAST[0].type === 0)
                            return;
                        node.value = buildFunction(icuAST);
                    }
                    else if (t.isTemplateLiteral(node.value) && node.value.quasis.length == 1) {
                        const quasis_value = node.value.quasis[0].value;
                        let icuAST = parse(quasis_value.raw, { ignoreTag: true });
                        if (icuAST.length === 1 && icuAST[0].type === 0)
                            return;
                        node.value = buildFunction(icuAST);
                    }
                },
                VariableDeclarator({ node }) {
                    if (t.isStringLiteral(node.init)) {
                        let icuAST = parse(node.init.value);
                        if (icuAST.length === 1 && icuAST[0].type === 0)
                            return;
                        node.init = buildFunction(icuAST);
                    }
                },
                ExportDefaultDeclaration({ node }) {
                    // let properties: (Identifier | StringLiteral)[] = [];
                    let properties = [];
                    if (!isObjectExpression(node.declaration))
                        throw new Error('The default export must be an object');
                    flattenObjectProperties(node.declaration, properties);
                    node.declaration = t.objectExpression(properties.map(([k, v]) => {
                        t.objectProperty(k, v);
                        if (t.isIdentifier(k) && t.isIdentifier(v) && k.name === v.name) {
                            return t.objectProperty(k, v, false, true);
                        }
                        else {
                            return t.objectProperty(k, v);
                        }
                    }));
                }
            }
        };
    });
}
;
