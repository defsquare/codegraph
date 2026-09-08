/** A dynamic import with a literal is an import edge; a computed one is dropped and counted. */
export async function load(name: string): Promise<unknown> {
  const reporting = await import("./reporting.js");
  const dynamic = await import(`./${name}.js`);
  return [reporting, dynamic];
}
