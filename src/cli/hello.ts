import { parseSubcommandArgs } from "./index.ts";

export async function cmdHello(argv: string[]): Promise<void> {
  const { values } = parseSubcommandArgs(argv, {
    name: { type: "string" },
  });

  const name = (values.name as string | undefined) || "world";
  process.stdout.write(`hello, ${name}\n`);
}
