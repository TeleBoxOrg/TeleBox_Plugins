import { Plugin } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { Api } from "telegram";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0];
const MAX_EXPR_LENGTH = 120;

const help_text = `🧮 <b>计算器插件</b>

<b>📝 功能描述:</b>
• 执行安全的四则运算表达式
• 支持括号、小数以及负数

<b>🔧 使用方法:</b>
• <code>${mainPrefix}calc 2+2*5</code>
• <code>${mainPrefix}calc (10-3)*4</code>
• <code>${mainPrefix}calc -(2-5)/3</code>

<b>💡 示例:</b>
• <code>${mainPrefix}calc 3+7</code> → 10
• <code>${mainPrefix}calc 8/2+5</code> → 9`;

class SafeMathParser {
  private static readonly operators: Record<string, { precedence: number }> = {
    "+": { precedence: 1 },
    "-": { precedence: 1 },
    "*": { precedence: 2 },
    "/": { precedence: 2 },
  };

  private static tokenize(expr: string): string[] {
    const cleaned = expr.replace(/\s+/g, "");
    if (!cleaned) {
      throw new Error("表达式为空");
    }
    if (!/^[0-9+\-*/().]+$/.test(cleaned)) {
      throw new Error("表达式包含不支持的字符");
    }

    const tokens: string[] = [];
    let current = "";

    const pushCurrent = () => {
      if (!current) return;
      if (!this.isNumber(current)) {
        throw new Error(`无效的数字: ${current}`);
      }
      tokens.push(current);
      current = "";
    };

    const isUnaryPosition = (index: number) =>
      index === 0 || cleaned[index - 1] === "(" || cleaned[index - 1] in this.operators;

    for (let i = 0; i < cleaned.length; i++) {
      const char = cleaned[i];

      if (/[0-9.]/.test(char)) {
        current += char;
        continue;
      }

      pushCurrent();

      if ((char === "-" || char === "+") && isUnaryPosition(i)) {
        if (char === "-") {
          if (i + 1 < cleaned.length && cleaned[i + 1] === "(") {
            tokens.push("-1");
            tokens.push("*");
            continue;
          }
          current = "-";
        }
        continue;
      }

      if (!(char in this.operators) && char !== "(" && char !== ")") {
        throw new Error(`未知操作符: ${char}`);
      }

      tokens.push(char);
    }

    pushCurrent();
    return tokens;
  }

  private static infixToPostfix(tokens: string[]): string[] {
    const output: string[] = [];
    const operators: string[] = [];

    for (const token of tokens) {
      if (this.isNumber(token)) {
        output.push(token);
        continue;
      }

      if (token === "(") {
        operators.push(token);
        continue;
      }

      if (token === ")") {
        while (operators.length && operators[operators.length - 1] !== "(") {
          output.push(operators.pop()!);
        }
        if (!operators.length) {
          throw new Error("括号不匹配");
        }
        operators.pop();
        continue;
      }

      while (
        operators.length &&
        operators[operators.length - 1] !== "(" &&
        operators[operators.length - 1] in this.operators &&
        this.operators[operators[operators.length - 1]].precedence >= this.operators[token].precedence
      ) {
        output.push(operators.pop()!);
      }
      operators.push(token);
    }

    while (operators.length) {
      const op = operators.pop()!;
      if (op === "(" || op === ")") {
        throw new Error("括号不匹配");
      }
      output.push(op);
    }

    return output;
  }

  private static evaluatePostfix(postfix: string[]): number {
    const stack: number[] = [];

    for (const token of postfix) {
      if (this.isNumber(token)) {
        stack.push(parseFloat(token));
        continue;
      }

      if (!(token in this.operators)) {
        throw new Error(`未知操作符: ${token}`);
      }

      if (stack.length < 2) {
        throw new Error("表达式格式错误");
      }

      const b = stack.pop()!;
      const a = stack.pop()!;

      let result: number;
      switch (token) {
        case "+":
          result = a + b;
          break;
        case "-":
          result = a - b;
          break;
        case "*":
          result = a * b;
          break;
        case "/":
          if (b === 0) {
            throw new Error("除零错误");
          }
          result = a / b;
          break;
        default:
          throw new Error(`未知操作符: ${token}`);
      }

      stack.push(result);
    }

    if (stack.length !== 1) {
      throw new Error("表达式格式错误");
    }

    return stack[0];
  }

  private static isNumber(token: string): boolean {
    return /^-?\d+(\.\d+)?$/.test(token);
  }

  static calculate(expression: string): number {
    const tokens = this.tokenize(expression);
    const postfix = this.infixToPostfix(tokens);
    return this.evaluatePostfix(postfix);
  }
}

class CalcPlugin extends Plugin {
  description: string = help_text;

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    calc: async (msg: Api.Message) => await this.handleCalc(msg),
  };

  private async handleCalc(msg: Api.Message): Promise<void> {
    try {
      const rawText = (msg.message ?? msg.text ?? "").trim();
      const parts = rawText.split(/\s+/);
      const [, ...args] = parts;

      if (!args.length) {
        await msg.edit({
          text: help_text,
          parseMode: "html",
          linkPreview: false,
        });
        return;
      }

      const expression = args.join(" ");

      if (expression.length > MAX_EXPR_LENGTH) {
        await msg.edit({
          text: `❌ <b>表达式过长</b>\\n\\n最大长度: ${MAX_EXPR_LENGTH} 字符\\n当前长度: ${expression.length}`,
          parseMode: "html",
        });
        return;
      }

      let result: number;
      try {
        result = SafeMathParser.calculate(expression);
      } catch (error: any) {
        await msg.edit({
          text: `🚫 <b>计算失败</b>\\n\\n表达式: <code>${this.htmlEscape(expression)}</code>\\n错误: ${this.htmlEscape(error?.message ?? "未知错误")}`,
          parseMode: "html",
        });
        return;
      }

      if (!Number.isFinite(result)) {
        await msg.edit({
          text: `🚫 <b>计算结果无效</b>\\n\\n表达式: <code>${this.htmlEscape(expression)}</code>` ,
          parseMode: "html",
        });
        return;
      }

      const formatted = this.formatResult(result);

      await msg.edit({
        text: `🧮 <b>计算结果</b>\\n\\n<code>${this.htmlEscape(expression)}</code>\\n= <b>${formatted}</b>`,
        parseMode: "html",
        linkPreview: false,
      });
    } catch (error: any) {
      await msg.edit({
        text: `❌ <b>插件错误</b>\\n\\n${this.htmlEscape(error?.message ?? "未知错误")}`,
        parseMode: "html",
      });
    }
  }

  private htmlEscape(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#x27;");
  }

  private formatResult(value: number): string {
    if (Number.isInteger(value)) {
      return value.toString();
    }

    const rounded = Math.round(value * 1e12) / 1e12;
    return rounded.toString().replace(/\.?0+$/, "");
  }
}

export default new CalcPlugin();
