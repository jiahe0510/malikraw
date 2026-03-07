import readline from "node:readline";
import readlinePromises from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

type SelectOption<T extends string> = {
  label: string;
  value: T;
};

const CLEAR_SCREEN = "\u001Bc";
const HIDE_CURSOR = "\u001B[?25l";
const SHOW_CURSOR = "\u001B[?25h";

export async function promptSelect<T extends string>(question: string, options: SelectOption<T>[]): Promise<T> {
  if (!input.isTTY || !output.isTTY) {
    return options[0].value;
  }

  input.resume();
  readline.emitKeypressEvents(input);
  input.setRawMode(true);

  let selectedIndex = 0;
  renderSelect(question, options, selectedIndex);

  return new Promise<T>((resolve) => {
    const onKeypress = (_value: string, key: readline.Key) => {
      if (key.name === "up") {
        selectedIndex = (selectedIndex - 1 + options.length) % options.length;
        renderSelect(question, options, selectedIndex);
        return;
      }

      if (key.name === "down") {
        selectedIndex = (selectedIndex + 1) % options.length;
        renderSelect(question, options, selectedIndex);
        return;
      }

      if (key.name === "return") {
        cleanup();
        resolve(options[selectedIndex].value);
        return;
      }

      if (key.ctrl && key.name === "c") {
        cleanup();
        process.exit(130);
      }
    };

    const cleanup = () => {
      input.off("keypress", onKeypress);
      input.setRawMode(false);
      output.write(SHOW_CURSOR);
      output.write("\n");
    };

    input.on("keypress", onKeypress);
  });
}

export async function promptText(question: string, defaultValue?: string, secret = false): Promise<string> {
  if (!input.isTTY || !output.isTTY) {
    return defaultValue ?? "";
  }

  input.resume();
  if (typeof input.setRawMode === "function") {
    input.setRawMode(false);
  }

  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const rl = readlinePromises.createInterface({ input, output });
  const answer = await rl.question(`${question}${suffix}: `);
  rl.close();
  input.resume();

  if (secret) {
    output.write("\n");
  }

  const trimmed = answer.trim();
  return trimmed || defaultValue || "";
}

function renderSelect<T extends string>(
  question: string,
  options: SelectOption<T>[],
  selectedIndex: number,
): void {
  output.write(CLEAR_SCREEN);
  output.write(HIDE_CURSOR);
  output.write(`${question}\n`);
  output.write("Use ↑/↓ to choose, Enter to confirm.\n\n");

  for (const [index, option] of options.entries()) {
    const marker = index === selectedIndex ? ">" : " ";
    output.write(`${marker} ${option.label}\n`);
  }
}
