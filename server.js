require("dotenv").config();
const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const { CORE_PROMPT, PATH_PROMPT, CAREER_PROMPT, ORCHESTRATOR_PROMPT } = require("./agents");
const Stripe = require("stripe");

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Webhook necesita raw body — va ANTES de express.json()
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

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✦ RenaIA corriendo en http://localhost:${PORT}`));