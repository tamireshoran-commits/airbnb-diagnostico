require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function paraNumero(valor) {
  if (valor === null || valor === undefined || valor === "") return null;
  const limpo = String(valor).trim().replace(",", ".");
  const n = parseFloat(limpo);
  return Number.isNaN(n) ? null : n;
}

// ROTA 1: Buscar dados automaticamente
app.post("/api/extrair", async (req, res) => {
  const { url } = req.body || {};

  if (!url || !/^https?:\/\/(www\.)?airbnb\.com/i.test(url)) {
    return res.status(400).json({ error: "Cole um link valido de um anuncio do Airbnb (ex: https://www.airbnb.com.br/rooms/12345)." });
  }

  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);

    const textoVisivel = await page.evaluate(() => document.body.innerText);
    const ariaLabels = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[aria-label]"))
        .map((el) => el.getAttribute("aria-label"))
        .filter(Boolean)
    );
    const textoPagina = textoVisivel + "\n" + ariaLabels.join("\n");

    let titulo = "";
    try {
      titulo = await page.$eval("h1", (el) => el.innerText.trim());
    } catch (_) {}
    if (!titulo) {
      try {
        titulo = await page.$eval('meta[property="og:title"]', (el) => el.content);
      } catch (_) {}
    }

    let nota = null;
    let numAvaliacoes = null;
    let m = textoPagina.match(/(\d[.,]\d{1,2})\s+de\s+5\s+estrelas\s+de\s+(\d+)\s+coment/i);
    if (m) {
      nota = paraNumero(m[1]);
      numAvaliacoes = parseInt(m[2], 10);
    }

    let descricao = "";
    try {
      const el = await page.$('[data-section-id*="DESCRIPTION"]');
      if (el) descricao = await el.textContent();
    } catch (_) {}
    if (!descricao) {
      try {
        descricao = await page.$eval('meta[name="description"]', (el) => el.content);
      } catch (_) {}
    }

    let fotos = [];
    try {
      const botaoFotos = await page.$('button:has-text("Mostrar todas as fotos"), a:has-text("Mostrar todas as fotos")');
      if (botaoFotos) {
        await botaoFotos.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(1500);
      }

      for (let i = 0; i < 15; i++) {
        await page.mouse.wheel(0, 2500);
        await page.waitForTimeout(350);
      }
      await page.waitForTimeout(800);

      const srcs = await page.$$eval('img[src*="muscache.com/im/pictures"]', (imgs) =>
        imgs.map((i) => i.src)
      );
      const vistos = new Set();
      fotos = srcs.filter((src) => {
        const chave = src.split("?")[0];
        if (vistos.has(chave) || /\/User\/original|avatar/i.test(chave)) return false;
        vistos.add(chave);
        return true;
      });

      const idMatch = url.match(/\/rooms\/(\d+)/);
      if (idMatch) {
        const urlFotos = `https://www.airbnb.com.br/rooms/${idMatch[1]}/photos`;
        try {
          await page.goto(urlFotos, { waitUntil: "domcontentloaded", timeout: 20000 });
          await page.waitForTimeout(2000);
          for (let i = 0; i < 15; i++) {
            await page.mouse.wheel(0, 2500);
            await page.waitForTimeout(300);
          }
          const srcs2 = await page.$$eval('img[src*="muscache.com/im/pictures"]', (imgs) =>
            imgs.map((i) => i.src)
          );
          srcs2.forEach((src) => {
            const chave = src.split("?")[0];
            if (!vistos.has(chave) && !/\/User\/original|avatar/i.test(chave)) {
              vistos.add(chave);
              fotos.push(src);
            }
          });
        } catch (_) {}
      }
    } catch (_) {}

    const categorias = {};
    const categoriasBusca = [
      { chave: "limpeza", termos: ["limpeza"] },
      { chave: "exatidao", termos: ["exatidão do anúncio", "exatidao do anuncio"] },
      { chave: "checkin", termos: ["check-in"] },
      { chave: "comunicacao", termos: ["comunicação", "comunicacao"] },
      { chave: "localizacao", termos: ["localização", "localizacao"] },
      { chave: "custo_beneficio", termos: ["custo-benefício", "custo-beneficio"] },
    ];

    for (const { chave, termos } of categoriasBusca) {
      for (const termo of termos) {
        const escapado = termo.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp("Pontuação:\\s*(\\d[.,]\\d{1,2})\\s+de\\s+5\\s+estrelas\\s+para\\s+" + escapado, "i");
        const m = textoPagina.match(regex);
        if (m) {
          categorias[chave] = paraNumero(m[1]);
          break;
        }
      }
    }

    return res.json({
      titulo,
      nota,
      num_avaliacoes: numAvaliacoes,
      descricao,
      fotos,
      categorias: Object.keys(categorias).length ? categorias : null,
    });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error("Erro em /api/extrair:", err.message);
    return res.status(502).json({ error: "Nao foi possivel buscar o anuncio: " + err.message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

// ROTA 2: Diagnostico
app.post("/api/diagnosticar", (req, res) => {
  const { nota, num_avaliacoes, num_fotos, descricao, categorias, meta } = req.body || {};
  const notaMeta = paraNumero(meta) ?? 4.85;

  // Avaliacoes necessarias
  const notaAtual = paraNumero(nota);
  const numAv = parseInt(num_avaliacoes, 10);

  let avaliacoes_necessarias = null;
  if (notaAtual !== null && !Number.isNaN(numAv)) {
    const somaAtual = notaAtual * numAv;
    const xBruto = (notaMeta * (numAv + 1) - somaAtual) / (5 - notaMeta);
    const necessarias = Math.max(0, Math.ceil(xBruto - 1e-9));
    const notaFinalEstimada = ((somaAtual + 5 * necessarias) / (numAv + necessarias)).toFixed(2);
    avaliacoes_necessarias = {
      jaAtingiu: notaAtual >= notaMeta,
      notaAtual: notaAtual.toFixed(2),
      meta: notaMeta,
      necessarias,
      notaFinalEstimada,
    };
  }

  // Descricao
  const NOMES_SECOES = { descricao_anuncio: "Descrição do anúncio", sua_propriedade: "Sua propriedade", acesso_hospede: "Acesso do hóspede", interacao_hospedes: "Interação com os hóspedes", outras_informacoes: "Outras informações importantes" };
  const descricaoPorSecao = {};
  ["descricao_anuncio", "sua_propriedade", "acesso_hospede", "interacao_hospedes", "outras_informacoes"].forEach((chave) => {
    descricaoPorSecao[chave] = { texto: "", pontosFortes: [], pontosAMelhorar: [] };
  });

  // Fotos
  const fotosPontosFortes = [];
  const fotosPontosAMelhorar = [];
  const numF = parseInt(num_fotos, 10);
  if (numF >= 20) fotosPontosFortes.push(`${numF} fotos, dentro da faixa recomendada pelo Airbnb (20 ou mais).`);
  else if (numF >= 10) fotosPontosAMelhorar.push(`${numF} fotos, abaixo do ideal. Airbnb recomenda 20 ou mais.`);
  else fotosPontosAMelhorar.push(`${numF} fotos, bem abaixo do recomendado. Airbnb ideal: 20+.`);

  // Selo
  const selo = {
    provavel_elegivel_pelos_criterios_publicos: notaAtual >= 4.9,
    minimo_5_avaliacoes: { valor_atual: numAv, atende: numAv >= 5 },
    categorias_detalhe: {},
    observacao: "Essa e uma estimativa baseada nos criterios publicos do Airbnb. O selo pode estar sujeito a outros fatores internos.",
    criterios_oficiais: [
      "Pelo menos 5 avaliacoes de hospedes",
      "Avaliacoes excelentes (nota geral na faixa de 4.9 ou mais, observado na pratica)",
      "Notas altas nas 6 categorias: check-in, limpeza, exatidao, comunicacao, localizacao e custo-beneficio",
      "Baixa taxa de cancelamento do anfitriao e poucos casos de suporte por qualidade",
      "Comunicacao entre hospede e anfitriao feita dentro da plataforma Airbnb",
    ],
  };

  if (categorias) {
    Object.entries(categorias).forEach(([chave, valor]) => {
      const nome = { limpeza: "Limpeza", exatidao: "Exatidão do anúncio", checkin: "Check-in", comunicacao: "Comunicação", localizacao: "Localização", custo_beneficio: "Custo-benefício" }[chave];
      if (nome) selo.categorias_detalhe[nome] = { valor: paraNumero(valor), referencia: 4.9, atende: paraNumero(valor) >= 4.85 };
    });
  }

  return res.json({
    avaliacoes_necessarias,
    descricao: { secoes: descricaoPorSecao, nomesSecoes: NOMES_SECOES },
    fotos: { pontosFortes: fotosPontosFortes, pontosAMelhorar: fotosPontosAMelhorar },
    selo_preferido_hospedes: selo,
  });
});

// ROTA 3: Proxy de foto
app.post("/api/proxy-foto", async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url || !/^https?:\/\//.test(url)) {
      return res.status(400).json({ error: "URL de foto invalida." });
    }

    const imgRes = await fetch(url, {
      headers: {
        Referer: "https://www.airbnb.com.br/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      },
    });
    if (!imgRes.ok) throw new Error(`HTTP ${imgRes.status}`);

    const buffer = Buffer.from(await imgRes.arrayBuffer());
    const mimeType = imgRes.headers.get("content-type") || "image/jpeg";
    const base64 = buffer.toString("base64");
    const dataUrl = `data:${mimeType};base64,${base64}`;

    return res.json({ dataUrl });
  } catch (err) {
    console.error("Erro em /api/proxy-foto:", err);
    return res.status(502).json({ error: "Nao foi possivel baixar a foto: " + err.message });
  }
});

// ROTA 4: Sugerir titulos
app.post("/api/sugerir-titulos", async (req, res) => {
  try {
    const { tituloAtual, descricao } = req.body || {};

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: "Chave da API do Gemini nao encontrada." });
    }

    const prompt =
      "Voce e um especialista em copywriting para anuncios de aluguel por temporada no Airbnb Brasil. " +
      `O titulo atual do anuncio e: "${tituloAtual || "(nao informado)"}". ` +
      `A descricao do anuncio e:\n"""${(descricao || "").slice(0, 2000)}"""\n\n` +
      "De 5 sugestoes de titulo MELHORES que esse. Cada titulo deve ter NO MAXIMO 50 caracteres. " +
      "Responda APENAS com os 5 titulos, um por linha, sem numeracao, sem aspas, sem texto explicativo.";

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      }
    );

    const data = await geminiRes.json();
    if (!geminiRes.ok) {
      const msgErro = data?.error?.message || "Erro desconhecido na API do Gemini.";
      return res.status(502).json({ error: msgErro });
    }

    const texto = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const titulos = texto
      .split("\n")
      .map((l) => l.replace(/^[-*\d.\s"]+/, "").replace(/"$/, "").trim())
      .filter(Boolean)
      .slice(0, 5);

    return res.json({ titulos });
  } catch (err) {
    console.error("Erro em /api/sugerir-titulos:", err);
    return res.status(500).json({ error: "Erro interno: " + err.message });
  }
});

// ROTA 5: Analisar fotos
app.post("/api/analisar-fotos", async (req, res) => {
  try {
    const { fotos } = req.body || {};

    if (!fotos || !Array.isArray(fotos) || !fotos.length) {
      return res.status(400).json({ error: "Nenhuma foto disponivel para analisar." });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: "Chave da API do Gemini nao encontrada." });
    }

    const LIMITE_FOTOS = 40;
    const fotosParaAnalisar = fotos.slice(0, LIMITE_FOTOS);
    const resultados = [];
    let cotaEstourada = false;

    for (const url of fotosParaAnalisar) {
      if (cotaEstourada) {
        resultados.push({ url, analise: null, erro: "Nao analisada: cota gratuita do Gemini foi atingida nesta rodada." });
        continue;
      }

      try {
        const imgRes = await fetch(url, {
          headers: {
            Referer: "https://www.airbnb.com.br/",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          },
        });
        if (!imgRes.ok) throw new Error(`HTTP ${imgRes.status}`);
        const buffer = Buffer.from(await imgRes.arrayBuffer());
        const mimeType = imgRes.headers.get("content-type") || "image/jpeg";
        const base64 = buffer.toString("base64");

        const prompt =
          "Voce e um especialista em fotografia para Airbnb. " +
          "Olhe esta foto e responda em portugues, em no maximo 2 frases: " +
          "(1) o que transmite bem e (2) uma sugestao de melhoria. " +
          "Seja concreto.";

        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${process.env.GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [
                {
                  parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: base64 } }],
                },
              ],
            }),
          }
        );

        const data = await geminiRes.json();
        if (!geminiRes.ok) {
          const status = data?.error?.status || "";
          const msgErro = data?.error?.message || "Erro desconhecido.";
          if (geminiRes.status === 429 || status === "RESOURCE_EXHAUSTED") {
            cotaEstourada = true;
            resultados.push({ url, analise: null, erro: "Cota gratuita do Gemini atingida." });
          } else {
            resultados.push({ url, analise: null, erro: msgErro });
          }
        } else {
          const texto = data?.candidates?.[0]?.content?.parts?.[0]?.text;
          resultados.push({ url, analise: texto ? texto.trim() : null, erro: null });
        }
      } catch (err) {
        resultados.push({ url, analise: null, erro: err.message });
      }

      await new Promise((r) => setTimeout(r, 4500));
    }

    return res.json({ resultados, total_analisadas: resultados.length, total_disponivel: fotos.length, cota_estourada: cotaEstourada });
  } catch (err) {
    console.error("Erro em /api/analisar-fotos:", err);
    return res.status(500).json({ error: "Erro interno: " + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando! Abra o navegador em: http://localhost:${PORT}`);
});
