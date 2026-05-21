require("dotenv").config();
const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const { CORE_PROMPT, PATH_PROMPT, CAREER_PROMPT, ORCHESTRATOR_PROMPT } = require("./agents");

const app = express();
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