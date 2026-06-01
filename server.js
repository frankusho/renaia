require("dotenv").config();
const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const { CORE_PROMPT, PATH_PROMPT, CAREER_PROMPT, ORCHESTRATOR_PROMPT } = require("./agents");
const Stripe = require("stripe");

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const userId = session.metadata?.userId;
    if (userId) {
      await supabase.from("usuarios").update({ is_pro: true }).eq("id", userId);
      console.log(`✦ Usuario ${userId} activado como Pro`);
    }
  }

  if (event.type === "customer.subscription.deleted") {
    const subscription = event.data.object;
    const userId = subscription.metadata?.userId;
    if (userId) {
      await supabase.from("usuarios").update({ is_pro: false }).eq("id", userId);
      console.log(`✦ Usuario ${userId} desactivado de Pro`);
    }
  }

  res.json({ received: true });
});

app.use(express.json());
app.use(express.static("public"));

const sesiones = {};

async function llamarGroq(mensajes, systemPrompt) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      max_tokens: 1024,
      messages: [
        { role: "system", content: systemPrompt },
        ...mensajes
      ]
    })
  });
  const data = await res.json();
  return data.choices[0].message.content;
}

async function orquestar(historial, mensajeActual) {
  const contexto = historial.slice(-6).map(m => `${m.role}: ${m.content}`).join("\n");
  const prompt = `Conversación reciente:\n${contexto}\n\nÚltimo mensaje: "${mensajeActual}"\n\n¿Qué agente responde?`;
  try {
    const respuesta = await llamarGroq([{ role: "user", content: prompt }], ORCHESTRATOR_PROMPT);
    const json = JSON.parse(respuesta.trim());
    return json.agente || "core";
  } catch {
    return "core";
  }
}

function obtenerPrompt(agente) {
  if (agente === "path") return PATH_PROMPT;
  if (agente === "career") return CAREER_PROMPT;
  return CORE_PROMPT;
}

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// ── STRIPE CHECKOUT ──
app.post("/crear-checkout", async (req, res) => {
  const { userId, email } = req.body;
  if (!userId) return res.status(400).json({ error: "Falta userId" });
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${process.env.APP_URL || "https://renaia.lat"}/app.html?upgraded=true`,
      cancel_url: `${process.env.APP_URL || "https://renaia.lat"}/app.html`,
      customer_email: email || undefined,
      metadata: { userId },
      subscription_data: { metadata: { userId } }
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe error:", err);
    res.status(500).json({ error: "Error creando checkout" });
  }
});

// ── GENERAR PROCESO ACTUAL ──
app.post("/generar-proceso", async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "Falta userId" });

  const { data: mem } = await supabase
    .from("memoria_usuario")
    .select("situacion_actual, ultimo_descubrimiento, proximo_paso, proceso_updated_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (mem?.situacion_actual && mem?.proceso_updated_at) {
    const age = Date.now() - new Date(mem.proceso_updated_at).getTime();
    if (age < 24 * 60 * 60 * 1000) {
      return res.json({
        situacion_actual: mem.situacion_actual,
        ultimo_descubrimiento: mem.ultimo_descubrimiento,
        proximo_paso: mem.proximo_paso,
        cached: true
      });
    }
  }

  const { data: convs } = await supabase
    .from("conversaciones")
    .select("rol, mensaje")
    .eq("usuario_id", userId)
    .order("created_at", { ascending: false })
    .limit(30);

  if (!convs?.length) {
    return res.json({
      situacion_actual: "Inicia una conversación para descubrir tu situación actual.",
      ultimo_descubrimiento: "Todavía no hemos tenido suficientes conversaciones.",
      proximo_paso: "Comienza hablando sobre tu situación profesional actual.",
      cached: false
    });
  }

  const resumen = convs
    .filter(m => m.mensaje?.length > 5)
    .map(m => `${m.rol === "user" ? "Usuario" : "RenaIA"}: ${m.mensaje.slice(0, 300)}`)
    .join("\n");

  const prompt = `Analiza estas conversaciones de reinvención profesional y genera un resumen en 3 partes. Sé específico, personal y conciso. Usa máximo 2 oraciones por campo. Escribe en segunda persona dirigido al usuario.

Conversaciones:
${resumen}

Responde SOLO con un JSON con exactamente estas 3 claves, sin markdown ni texto adicional:
{
  "situacion_actual": "descripción de dónde está la persona hoy profesionalmente",
  "ultimo_descubrimiento": "qué aprendimos o descubrimos en las conversaciones recientes",
  "proximo_paso": "acción concreta y específica que debería tomar próximamente"
}`;

  try {
    const respuesta = await llamarGroq(
      [{ role: "user", content: prompt }],
      "Eres un coach de reinvención profesional experto. Generas resúmenes concisos, específicos y humanos del proceso de una persona basándote en sus conversaciones reales. Solo respondes con JSON válido."
    );

    const clean = respuesta.replace(/```json|```/g, "").trim();
    const proceso = JSON.parse(clean);

    await supabase.from("memoria_usuario").upsert(
      {
        user_id: userId,
        situacion_actual: proceso.situacion_actual,
        ultimo_descubrimiento: proceso.ultimo_descubrimiento,
        proximo_paso: proceso.proximo_paso,
        proceso_updated_at: new Date().toISOString()
      },
      { onConflict: "user_id" }
    );

    res.json({ ...proceso, cached: false });
  } catch (err) {
    console.error("Proceso error:", err);
    res.json({
      situacion_actual: "Estás explorando tu situación profesional y buscando claridad.",
      ultimo_descubrimiento: "Cada conversación nos acerca más a entender tu camino.",
      proximo_paso: "Continúa conversando para definir tu próximo paso concreto.",
      cached: false
    });
  }
});

// ── GENERAR INSIGHTS ──
app.post("/generar-insights", async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "Falta userId" });

  const { data: mem } = await supabase
    .from("memoria_usuario")
    .select("insights, insights_updated_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (mem?.insights && mem?.insights_updated_at) {
    const age = Date.now() - new Date(mem.insights_updated_at).getTime();
    if (age < 24 * 60 * 60 * 1000) {
      try {
        return res.json({ insights: JSON.parse(mem.insights), cached: true });
      } catch {}
    }
  }

  const { data: convs } = await supabase
    .from("conversaciones")
    .select("rol, mensaje")
    .eq("usuario_id", userId)
    .order("created_at", { ascending: false })
    .limit(20);

  if (!convs?.length) return res.json({ insights: [] });

  const resumen = convs
    .filter(m => m.mensaje?.length > 5)
    .map(m => `${m.rol === "user" ? "Usuario" : "RenaIA"}: ${m.mensaje.slice(0, 200)}`)
    .join("\n");

  const prompt = `Analiza estas conversaciones de reinvención profesional y genera exactamente 3 insights cortos, específicos y personales sobre esta persona.

Cada insight debe ser una observación concreta sobre sus patrones, motivaciones, miedos o situación actual. Escríbelos en segunda persona (dirigidos a la persona). Máximo 20 palabras por insight.

Conversaciones:
${resumen}

Responde SOLO con un JSON array de exactamente 3 strings. Sin explicaciones, sin markdown, sin texto adicional.
Ejemplo: ["Has mencionado varias veces que buscas independencia.", "La incertidumbre parece ser tu mayor freno.", "Tienes más claridad de lo que crees."]`;

  try {
    const respuesta = await llamarGroq(
      [{ role: "user", content: prompt }],
      "Eres un coach de reinvención profesional experto en detectar patrones. Generas insights concisos, específicos y humanos basados en conversaciones reales. Solo respondes con JSON."
    );

    const clean = respuesta.replace(/```json|```/g, "").trim();
    const insights = JSON.parse(clean);

    await supabase.from("memoria_usuario").upsert(
      { user_id: userId, insights: JSON.stringify(insights), insights_updated_at: new Date().toISOString() },
      { onConflict: "user_id" }
    );

    res.json({ insights, cached: false });
  } catch (err) {
    console.error("Insights error:", err);
    res.json({ insights: [
      "Sigue conversando para que pueda conocerte mejor.",
      "Cada conversación me ayuda a entenderte más.",
      "Estás en el camino correcto."
    ]});
  }
});

// ── CHAT ──
app.post("/chat", async (req, res) => {
  const { mensaje, sesionId } = req.body;
  if (!mensaje || !sesionId) return res.status(400).json({ error: "Faltan datos" });

  if (!sesiones[sesionId]) {
    const { data } = await supabase
      .from("conversaciones")
      .select("rol, mensaje, agente")
      .eq("usuario_id", sesionId)
      .order("created_at", { ascending: true });

    sesiones[sesionId] = {
      mensajes: data ? data.map(m => ({ role: m.rol, content: m.mensaje })) : [],
      agente: data && data.length > 0 ? data[data.length - 1].agente : "core"
    };
  }

  const sesion = sesiones[sesionId];
  sesion.mensajes.push({ role: "user", content: mensaje });

  await supabase.from("conversaciones").insert({
    usuario_id: sesionId,
    rol: "user",
    mensaje,
    agente: sesion.agente
  });

  try {
    const agente = await orquestar(sesion.mensajes, mensaje);
    sesion.agente = agente;

    const respuesta = await llamarGroq(sesion.mensajes, obtenerPrompt(agente));
    sesion.mensajes.push({ role: "assistant", content: respuesta });

    await supabase.from("conversaciones").insert({
      usuario_id: sesionId,
      rol: "assistant",
      mensaje: respuesta,
      agente
    });

    res.json({ respuesta, agente });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// ── CARTÓGRAFO: guardar + generar párrafo ──
app.post("/api/cartografo", async (req, res) => {
  const { userId, answers, scores, fase, desafio } = req.body;
  if (!userId || !scores || !fase) {
    return res.status(400).json({ error: "Faltan datos" });
  }

  console.log("CARTOGRAFO: iniciando para userId:", userId);

  const { data: usuarioExiste } = await supabase
    .from("usuarios")
    .select("id")
    .eq("id", userId)
    .maybeSingle();

  if (!usuarioExiste) {
    console.log("CARTOGRAFO: usuario no existe en tabla, insertando...");
    await supabase.from("usuarios").insert({ id: userId });
  }

  const { error: upsertError } = await supabase
    .from("cartografo_resultados")
    .upsert(
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
        tiempo_situacion: String(answers?.P2 || ''),
        contexto_adicional: answers?.CIERRE || null,
        respuestas_raw: answers,
        version: 1
      },
      { onConflict: "usuario_id" }
    );

  if (upsertError) {
    console.error("CARTOGRAFO upsert error:", JSON.stringify(upsertError));
  } else {
    console.log("CARTOGRAFO: upsert exitoso");
  }

  const { error: updateError } = await supabase
    .from("usuarios")
    .update({ roadmap_fase: 1, cartografo_completado: true })
    .eq("id", userId);

  if (updateError) {
    console.error("CARTOGRAFO update usuarios error:", JSON.stringify(updateError));
  }

  const parrafo = await generarParrafoCartografo(scores, fase, desafio, answers);

  if (parrafo) {
    const { error: parrafoError } = await supabase
      .from("cartografo_resultados")
      .update({ resumen_ia: parrafo })
      .eq("usuario_id", userId);

    if (parrafoError) {
      console.error("CARTOGRAFO parrafo save error:", JSON.stringify(parrafoError));
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
    '20': 'menos de 1 mes',
    '40': 'entre 1 y 3 meses',
    '60': 'entre 3 y 6 meses',
    '80': 'entre 6 meses y 1 año',
    '95': 'más de 1 año',
  }[String(tiempo)] || null;

  const prompt = `Eres el Cartógrafo de RenaIA. Observas a personas en procesos de reinvención profesional y describes lo que ves, como alguien que genuinamente las ha escuchado.

Datos de esta persona:
- Situación: ${situacionTexto}
${tiempoTexto ? `- Lleva: ${tiempoTexto} en esta situación` : ''}
- Fase detectada: ${fase}
- Claridad: ${scores.claridad}/100
- Confianza: ${scores.confianza}/100
- Estado emocional: ${scores.emocional}/100
- Urgencia financiera: ${scores.urgencia}/100
- Principal bloqueo: ${desafio}
${scores.flags?.tension_emocional ? '- Tiene emociones contrapuestas: esperanza y miedo/frustración al mismo tiempo' : ''}
${scores.flags?.presion_critica ? '- Presión económica crítica: necesita resultados pronto' : ''}
${contexto ? `- Agregó esto al final: "${contexto}"` : ''}

Escribe UN SOLO PÁRRAFO de 3 a 5 oraciones comenzando con "Lo que más me llama la atención es..." o "Lo que aparece en tu proceso es..." o una frase similar que comunique observación directa, no análisis.

Reglas estrictas:
- Escribe en segunda persona (tú), como si le hablaras directamente
- NUNCA menciones porcentajes ni números de scores
- NUNCA uses frases como "estás en el camino correcto", "todo va a estar bien", "es normal sentirse así"
- NUNCA des consejos ni próximos pasos
- NUNCA suenes como terapeuta ni como coach motivacional
- SÍ puedes nombrar la tensión real que vive esta persona
- SÍ puedes cerrar con algo genuinamente positivo que sea verdad, no consuelo vacío
- El tono debe sentirse como alguien que te vio de verdad, no como un reporte

Solo el párrafo. Sin comillas, sin encabezado, sin explicación.`;

  try {
    const respuesta = await llamarGroq(
      [{ role: "user", content: prompt }],
      "Eres el Cartógrafo de RenaIA. Observas y describes con precisión humana. Nunca analizas con números. Escribes solo lo que se te pide, nada más."
    );
    return respuesta.trim();
  } catch(e) {
    console.error("Groq párrafo error:", e);
    return null;
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✦ RenaIA corriendo en http://localhost:${PORT}`));