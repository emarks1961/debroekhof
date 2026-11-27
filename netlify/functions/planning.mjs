// Geplande taak: elke ochtend aankomstmails (4 dagen vooraf) en op maandag
// de betaalwaarschuwing. Het werk zelf gebeurt in actie.mjs ("dagelijks").
// 06:00 UTC = 07:00 (winter) of 08:00 (zomer) Nederlandse tijd.
export default async () => {
  const basis = process.env.URL;
  const res = await fetch(`${basis}/api/actie`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-broekhof-geheim': process.env.INTERN_GEHEIM || '' },
    body: JSON.stringify({ actie: 'dagelijks' }),
  });
  const tekst = await res.text();
  console.log(`[planning] HTTP ${res.status}: ${tekst.slice(0, 1000)}`);
  if (!res.ok) throw new Error(`Dagelijkse taak mislukt (HTTP ${res.status})`);
};

export const config = { schedule: '0 6 * * *' };
