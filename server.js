// ── CARTÓGRAFO: guardar + generar párrafo ──
app.post("/api/cartografo", async (req, res) => {
  const { userId, answers, scores, fase, desafio } = req.body;
  if (!userId || !scores || !fase) {
    return res.status(400).json({ error: "Faltan datos" });
  }

  try {
    await supabase.from("cartografo_resultados").upsert(
      {
        usuario_id: userId,
        fase,
        score_claridad: scores.claridad,
        score_confianza: scores.confianza,
        score_emocional: scores.emocional,
        score_urgencia: scores.urgencia,
        tension_emocional: scores.flags?.tension_emocional || false,
        presion_critica: scores.flags?.presion_critica || false,
        principal_desafio: desafio,
        situacion_laboral: answers?.P1 || null,
        tiempo_situacion: answers?.P2 || null,
        contexto_adicional: answers?.CIERRE || null,
        respuestas_raw: answers,
        version: 1
      },
      { onConflict: "usuario_id" }
    );

    await supabase
      .from("usuarios")
      .update({ roadmap_fase: 1, cartografo_completado: true })
      .eq("id", userId);
  } catch (err) {
    console.error("Cartógrafo Supabase error:", err);
  }

  const parrafo = await generarParrafoCartografo(scores, fase, desafio, answers);

  if (parrafo) {
    try {
      await supabase
        .from("cartografo_resultados")
        .update({ resumen_ia: parrafo })
        .eq("usuario_id", userId);
    } catch(e) {
      console.error("Error guardando párrafo:", e);
    }
  }

  res.json({ ok: true, parrafo });
});

// ── CARTÓGRAFO: regenerar párrafo (fallback) ──
app.post("/api/cartografo/parrafo", async (req, res) => {
  const { scores, fase, desafio, answers } = req.body;
  if (!scores || !fase) return res.status(400).json({ error: "Faltan datos" });
  const parrafo = await generarParrafoCartografo(scores, fase, desafio, answers);
  res.json({ parrafo });
});

// ── Helper: generar párrafo con Groq ──
async function generarParrafoCartografo(scores, fase, desafio, answers) {
  const situacion = answers?.P1 || null;
  const tiempo = answers?.P2 || null;
  const contexto = answers?.CIERRE || null;

  const situacionTexto = {
    'trabaja_cambio':     'está trabajando pero quiere cambiar de rumbo',
    'trabaja_estancado':  'está trabajando pero se siente estancado/a',
    'perdio_reciente':    'acaba de dejar o perder su trabajo hace menos de 3 meses',
    'sin_trabajo_largo':  'lleva más de 3 meses sin trabajar',
    'transicion':         'está en transición activa entre proyectos',
    'sin_claridad':       'nunca ha tenido claridad sobre su camino profesional',
  }[situacion] || 'situación profesional en transición';

  const tiempoTexto = {
    20: 'menos de 1 mes',
    40: 'entre 1 y 3 meses',
    60: 'entre 3 y 6 meses',
    80: 'entre 6 meses y 1 año',
    95: 'más de 1 año',
  }[tiempo] || null;

  const prompt = `Eres el Cartógrafo de RenaIA. Tu función es diagnosticar dónde se encuentra una persona en su proceso de reinvención profesional.

Datos del diagnóstico:
- Fase detectada: ${fase}
- Claridad: ${scores.claridad}/100
- Confianza: ${scores.confianza}/100
- Estado emocional: ${scores.emocional}/100
- Urgencia: ${scores.urgencia}/100
- Situación: ${situacionTexto}
${tiempoTexto ? `- Tiempo en esta situación: ${tiempoTexto}` : ''}
- Principal desafío: ${desafio}
${scores.flags?.tension_emocional ? '- Tensión emocional: tiene emociones contrapuestas simultáneamente' : ''}
${scores.flags?.presion_critica ? '- PRESIÓN CRÍTICA: situación económica urgente' : ''}
${contexto ? `- Lo que la persona agregó: "${contexto}"` : ''}

Escribe UN SOLO PÁRRAFO de 3 a 5 oraciones en segunda persona (tú) que:
1. Describa con precisión dónde está esta persona hoy, usando sus datos reales
2. Identifique la tensión central de su momento
3. Cierre con algo genuinamente positivo que sea verdad, no motivacional vacío

Tono: humano, directo, sin jerga de coach.
NO uses frases como "estás en el camino correcto" o "todo va a estar bien".
NO des consejos ni próximos pasos.
Solo el párrafo. Sin comillas, sin encabezado.`;

  try {
    const respuesta = await llamarGroq(
      [{ role: "user", content: prompt }],
      "Eres el Cartógrafo de RenaIA. Generas diagnósticos precisos y humanos. Escribes solo lo que se te pide."
    );
    return respuesta.trim();
  } catch(e) {
    console.error("Groq párrafo error:", e);
    return null;
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✦ RenaIA corriendo en http://localhost:${PORT}`));