import { ToolRegistry, defineTool, s } from "../index.js";

const sumSchema = s.object(
  {
    values: s.array(s.number({ integer: true }), { minItems: 1 }),
  },
  { required: ["values"] },
);

const sumTool = defineTool({
  name: "sum_numbers",
  description: "Add a list of integers and return the total.",
  inputSchema: sumSchema,
  execute: ({ values }) => ({
    total: values.reduce((acc: number, value: number) => acc + value, 0),
  }),
});

async function main(): Promise<void> {
  const registry = new ToolRegistry();
  registry.register(sumTool);

  const success = await registry.execute("sum_numbers", { values: [1, 2, 3] });
  const failure = await registry.execute("sum_numbers", { values: [1, "x", 3] });

  console.log(JSON.stringify({ success, failure, trace: registry.traceLog.list() }, null, 2));
}

void main();
