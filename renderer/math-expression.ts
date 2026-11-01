type Variables = Readonly<Record<string, number>>;
type Expression = (variables: Variables) => number;
const functions: Record<string, { arity: number; run: (...values: number[]) => number }> = {
    ...Object.fromEntries(['sin', 'cos', 'tan', 'abs', 'sqrt', 'floor', 'ceil', 'round'].map(name =>
        [name, { arity: 1, run: Math[name as 'sin'] }])),
    min: { arity: 2, run: Math.min }, max: { arity: 2, run: Math.max }, pow: { arity: 2, run: Math.pow },
    clamp: { arity: 3, run: (value, min, max) => Math.max(min, Math.min(max, value)) }
};

export function compileMathExpression(source: string, names: readonly string[] = []): Expression | null {
    if (!source.trim() || source.length > 1024) return null;
    const tokens = source.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|[a-z_]\w*|\S/gi) ?? [];
    let cursor = 0;
    const finite = (value: number) => Number.isFinite(value) ? value : NaN;
    function primary(): Expression {
        const token = tokens[cursor++];
        if (token === 'pi') return () => Math.PI;
        if (names.includes(token)) return variables => Object.prototype.hasOwnProperty.call(variables, token) ? finite(variables[token]) : NaN;
        if (Object.prototype.hasOwnProperty.call(functions, token)) {
            if (tokens[cursor++] !== '(') throw new Error('Expected (');
            const args = [expression()];
            while (tokens[cursor] === ',') { cursor++; args.push(expression()); }
            const fn = functions[token];
            if (tokens[cursor++] !== ')' || args.length !== fn.arity) throw new Error('Invalid function arguments');
            return variables => {
                const values = args.map(value => value(variables));
                return values.every(Number.isFinite) ? finite(fn.run(...values)) : NaN;
            };
        }
        if (token === '(') {
            const value = expression();
            if (tokens[cursor++] !== ')') throw new Error('Expected )');
            return value;
        }
        if (!token || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(token) || !Number.isFinite(Number(token))) throw new Error('Invalid number');
        return () => Number(token);
    }

    function power(): Expression {
        const left = primary();
        if (tokens[cursor] !== '^') return left;
        cursor++;
        const right = unary();
        return variables => {
            const a = left(variables), b = right(variables);
            return Number.isFinite(a) && Number.isFinite(b) ? finite(a ** b) : NaN;
        };
    }

    function unary(): Expression {
        const token = tokens[cursor];
        if (token !== '+' && token !== '-') return power();
        cursor++;
        const value = unary();
        return variables => (token === '-' ? -1 : 1) * value(variables);
    }

    function product(): Expression {
        let value = unary();
        while (['*', '/', '%'].includes(tokens[cursor])) {
            const operator = tokens[cursor++];
            const left = value, right = unary();
            value = variables => finite(operator === '*' ? left(variables) * right(variables)
                : operator === '/' ? left(variables) / right(variables) : left(variables) % right(variables));
        }
        return value;
    }

    function expression(): Expression {
        let value = product();
        while (tokens[cursor] === '+' || tokens[cursor] === '-') {
            const operator = tokens[cursor++];
            const left = value, right = product();
            value = variables => finite(operator === '+' ? left(variables) + right(variables) : left(variables) - right(variables));
        }
        return value;
    }

    try {
        const value = expression();
        return cursor === tokens.length ? value : null;
    } catch { return null; }
}

export function evaluateMathExpression(source: string, variables: Variables = {}): number | null {
    const value = compileMathExpression(source, Object.keys(variables))?.(variables);
    return value !== undefined && Number.isFinite(value) ? value : null;
}
