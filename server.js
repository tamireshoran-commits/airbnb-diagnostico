// Servidor da ferramenta "Diagnostico de anuncio Airbnb"
// Isso e o backend que faltava: sem ele, o botao "Buscar automaticamente"
// nunca vai funcionar, porque o navegador do usuario (client-side) nao
// consegue acessar o Airbnb diretamente (bloqueio de CORS e anti-robo).

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

// ---------- Utilitarios ----------

function paraNumero(valor) {
  if (valor === null || valor === undefined || valor === "") return null;
  const limpo = String(valor).trim().replace(",", ".");
  const n = parseFloat(limpo);
  return Number.isNaN(n) ? null : n;
}

// ---------- ROTA 1: Buscar dados automaticamente no anuncio ----------

app.post("/api/extrair", async (req, res) => {
  const { url } = req.body || {};

  if (!url || !/^https?:\/\/(www\.)?airbnb\.com/i.test(url)) {
    return res.status(400).json({ error: "Cole um link valido de um anuncio do Airbnb (ex: https://www.airbnb.com.br/rooms/12345)." });
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      locale: "pt-BR",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      viewport: { width: 1366, height: 900 },
    });
    const page = await context.newPage();

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    // Da um tempo extra para o conteudo carregado via JavaScript aparecer.
    await page.waitForTimeout(3500);
    try {
      await page.waitForSelector("text=/estrelas/i", { timeout: 8000 });
    } catch (_) {
      // Segue mesmo se nao achar a tempo; tenta extrair o que der.
    }

    const textoVisivel = await page.evaluate(() => document.body.innerText);
    // Varios numeros (nota geral, notas por categoria) o Airbnb expoe so
    // via aria-label (texto para leitor de tela), que NAO aparece no
    // innerText normal. Por isso tambem coletamos os aria-labels da pagina
    // e juntamos tudo numa unica string de busca.
    const ariaLabels = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[aria-label]"))
        .map((el) => el.getAttribute("aria-label"))
        .filter(Boolean)
    );
    const textoPagina = textoVisivel + "\n" + ariaLabels.join("\n");

    // Titulo do anuncio (para mostrar em destaque no topo dos resultados)
    let titulo = "";
    try {
      titulo = await page.$eval("h1", (el) => el.innerText.trim());
    } catch (_) {}
    if (!titulo) {
      try {
        titulo = await page.$eval('meta[property="og:title"]', (el) => el.content);
      } catch (_) {}
    }

    // Nota geral e numero de avaliacoes
    // Ex: "4,82 de 5 estrelas de 45 comentários" ou "4,82 · 45 avaliações"
    let nota = null;
    let numAvaliacoes = null;

    let m = textoPagina.match(/(\d[.,]\d{1,2})\s+de\s+5\s+estrelas\s+de\s+(\d+)\s+coment/i);
    if (m) {
      nota = paraNumero(m[1]);
      numAvaliacoes = parseInt(m[2], 10);
    }
    if (nota === null) {
      m = textoPagina.match(/(\d[.,]\d{1,2})\s*·\s*(\d+)\s*avalia/i);
      if (m) {
        nota = paraNumero(m[1]);
        numAvaliacoes = parseInt(m[2], 10);
      }
    }

    // Notas por categoria.
    // Busca cada categoria individualmente (em vez de um regex global) para
    // evitar pegar numero errado quando o texto da pagina vem em ordem
    // diferente do esperado.
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
        const escapado = termo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(
          `Pontuação:\\s*(\\d[.,]\\d{1,2})\\s*de\\s*5\\s*estrelas\\s*para\\s*${escapado}`,
          "i"
        );
        const m = textoPagina.match(regex);
        if (m) {
          categorias[chave] = paraNumero(m[1]);
          break;
        }
      }
    }

    // Descricao: tenta varias fontes, da mais completa para a mais simples.
    let descricao = "";
    try {
      // 1) Bloco de descricao renderizado na pagina (mais completo)
      descricao = await page.evaluate(() => {
        const candidatos = Array.from(
          document.querySelectorAll('[data-section-id*="DESCRIPTION"], [data-testid*="description"]')
        );
        for (const el of candidatos) {
          const texto = (el.innerText || "").trim();
          if (texto.length > 80) return texto;
        }
        return "";
      });
    } catch (_) {}
    if (!descricao || descricao.length < 80) {
      // 2) Meta description da pagina (mais curta, mas sempre existe)
      try {
        let metaDesc = await page.$eval('meta[name="description"]', (el) => el.content);
        metaDesc = metaDesc.replace(/^\d{1,2} de [a-zç]+\.? de \d{4}\s*·\s*/i, "").trim();
        if (metaDesc.length > descricao.length) descricao = metaDesc;
      } catch (_) {}
    }

    // Fotos: o Airbnb carrega as fotos aos poucos conforme a pagina rola
    // (lazy loading), entao so abrir a galeria nao é suficiente, e preciso
    // rolar dentro dela para forcar o carregamento de todas antes de contar.
    let fotos = [];
    try {
      const botaoFotos = await page.$(
        'button:has-text("Mostrar todas as fotos"), a:has-text("Mostrar todas as fotos")'
      );
      if (botaoFotos) {
        await botaoFotos.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(1500);
      }

      // Rola varias vezes para forcar o carregamento das fotos que ainda
      // nao apareceram na tela (lazy loading).
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

      // Segunda tentativa: pagina dedicada de fotos do anuncio, que costuma
      // listar tudo em uma grade so, sem precisar abrir modal.
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
        } catch (_) {
          // Se a pagina de fotos nao existir ou falhar, fica so com o que
          // ja foi coletado da galeria normal.
        }
      }
    } catch (_) {}

    await browser.close();

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
    return res.status(502).json({
      error:
        "Nao foi possivel ler o anuncio agora (o Airbnb pode ter bloqueado a tentativa ou mudado o layout da pagina). Preencha os campos manualmente.",
    });
  }
});

// ---------- ROTA 2: Gerar o diagnostico ----------

app.post("/api/diagnosticar", (req, res) => {
  const body = req.body || {};

  const nota = paraNumero(body.nota);
  const numAvaliacoes = parseInt(body.num_avaliacoes, 10);
  const numFotos = parseInt(body.num_fotos, 10);
  const descricao = (body.descricao || "").trim();
  const categorias = body.categorias || null;
  const meta = paraNumero(body.meta) ?? 4.85;

  if (nota === null || Number.isNaN(numAvaliacoes)) {
    return res.status(400).json({ error: "Informe pelo menos a nota geral e o numero de avaliacoes." });
  }

  // ----- 1. Avaliacoes necessarias para atingir a meta -----
  let avaliacoesNecessarias;
  if (nota >= meta) {
    avaliacoesNecessarias = {
      jaAtingiu: true,
      notaAtual: nota,
      meta,
    };
  } else {
    const somaAtual = nota * numAvaliacoes;
    // (soma + 5x) / (n + x) >= meta  =>  x >= (meta*n - soma) / (5 - meta)
    const xBruto = (meta * numAvaliacoes - somaAtual) / (5 - meta);
    const necessarias = Math.max(1, Math.ceil(xBruto - 1e-9));
    const notaFinal = (somaAtual + 5 * necessarias) / (numAvaliacoes + necessarias);
    avaliacoesNecessarias = {
      jaAtingiu: false,
      notaAtual: nota,
      meta,
      necessarias,
      notaFinalEstimada: Math.round(notaFinal * 100) / 100,
    };
  }

  // ----- 2. Descricao, separada nas 5 secoes do editor do Airbnb -----
  // O Airbnb organiza a descricao do anuncio nesses blocos. Quando o
  // hospede ve o anuncio publicado, esses blocos aparecem como texto
  // corrido com os titulos entre eles, entao conseguimos separar de volta
  // procurando por esses titulos dentro do texto colado.
  const CABECALHOS_SECAO = [
    { chave: "sua_propriedade", nomeExibicao: "Sua propriedade", padroes: [/^o\s+espa[cç]o$/i, /^sua\s+propriedade$/i] },
    { chave: "acesso_hospede", nomeExibicao: "Acesso do hóspede", padroes: [/^acesso\s+(do\s+)?h[oó]spede$/i] },
    { chave: "interacao_hospedes", nomeExibicao: "Interação com os hóspedes", padroes: [/^intera[cç][aã]o\s+com\s+(os\s+)?h[oó]spedes$/i] },
    { chave: "outras_informacoes", nomeExibicao: "Outras informações importantes", padroes: [/^outras\s+observa[cç][oõ]es$/i, /^outras\s+informa[cç][oõ]es(\s+importantes)?$/i] },
  ];

  function separarSecoesDescricao(textoCompleto) {
    const linhas = (textoCompleto || "").split(/\r?\n/);
    const secoes = { descricao_anuncio: [] };
    let secaoAtual = "descricao_anuncio";

    linhas.forEach((linhaBruta) => {
      const linha = linhaBruta.trim();
      const cabecalho = CABECALHOS_SECAO.find((c) => c.padroes.some((p) => p.test(linha)));
      if (cabecalho) {
        secaoAtual = cabecalho.chave;
        if (!secoes[secaoAtual]) secoes[secaoAtual] = [];
        return; // nao guarda a linha do titulo, so marca a troca de secao
      }
      if (!secoes[secaoAtual]) secoes[secaoAtual] = [];
      secoes[secaoAtual].push(linhaBruta);
    });

    const resultado = {};
    Object.entries(secoes).forEach(([chave, linhasSecao]) => {
      resultado[chave] = linhasSecao.join("\n").trim();
    });
    return resultado;
  }

  function detectarLinguagemRestritiva(texto) {
    const termosProibitivos = [
      /\bproibid[oa]\b/i,
      /\bn[aã]o\s+[eé]\s+permitido\b/i,
      /\bsujeito\s+a\s+multa\b/i,
      /\bn[aã]o\s+nos\s+responsabilizamos\b/i,
      /\bser[aá]\s+penalizad[oa]\b/i,
      /\bdever[aá]\b/i,
      /\bmuito\s+rigoroso\b/i,
      /\bATEN[CÇ][AÃ]O\b/,
    ];
    let contagem = 0;
    termosProibitivos.forEach((re) => {
      const m = texto.match(new RegExp(re, "gi"));
      if (m) contagem += m.length;
    });
    const temMotivo = /\bpara\s+(preservar|manter|garantir|evitar)|por\s+seguran[cç]a|para\s+que\s+todos|em\s+respeito\b/i.test(texto);
    const temCaixaAlta = /\b[A-ZÀ-Ú]{4,}\b/.test(texto.replace(/\b(WIFI|WI-FI|TV|AC)\b/g, ""));
    return { contagem, temMotivo, temCaixaAlta };
  }

  function avaliarSecao(chave, texto) {
    const fortes = [];
    const melhorar = [];
    const palavras = texto ? texto.split(/\s+/).filter(Boolean).length : 0;

    if (!texto) {
      melhorar.push("Secao nao preenchida (ou nao foi encontrada no texto colado).");
    }

    if (chave === "descricao_anuncio") {
      if (!texto) {
        melhorar.push("Todo anuncio deveria abrir respondendo: para quem e esse lugar, e qual e o principal diferencial.");
      } else {
        if (palavras < 25) {
          melhorar.push(`Texto de abertura curto (${palavras} palavras). O hospede decide em segundos se "isso e para mim", vale reforcar o diferencial.`);
        } else {
          fortes.push(`Abertura com bom volume de conteudo (${palavras} palavras).`);
        }

        if (/^\s*(apartamento|im[oó]vel|espa[cç]o|casa)\s+(localizad[oa]|situad[oa])\s+em\b/i.test(texto)) {
          melhorar.push('Comeca com "Apartamento localizado em...", isso e generico. Melhor abrir pelo beneficio: para quem e, o que resolve, o que torna especial.');
        }

        const alvoHospede = /\bcasal\b|\bfam[ií]lia\b|\btrabalho\b|\bexecutivos?\b|\bturismo\b|\blazer\b|\bneg[oó]cios\b/i;
        if (!alvoHospede.test(texto)) {
          melhorar.push("Nao fica claro para qual tipo de hospede o lugar e ideal (casal, familia, trabalho, turismo). Isso ajuda o hospede certo a se identificar rapido.");
        }

        const amenidades = (texto.match(/\bwi-?fi\b|\btv\b|\bar-?condicionado\b|\bgeladeira\b|\bmicro-?ondas\b|\bfog[aã]o\b/gi) || []).length;
        const temBeneficioJunto = /\bpara\s+(trabalhar|relaxar|refei[cç][oõ]es|voc[eê])|\bideal\s+para\b|\bperfeito\s+para\b/i.test(texto);
        if (amenidades >= 3 && !temBeneficioJunto) {
          melhorar.push('Parece lista de equipamentos ("Wi-Fi, TV, ar-condicionado..."). Comodidade tecnica fica melhor em "Sua propriedade"; aqui, transforme em beneficio (ex: "Wi-Fi para trabalhar, ar-condicionado para os dias quentes").');
        }

        if (!/\d+\s*m\b|metros|km|minutos|est[aá][cç][aã]o|shopping|avenida|bairro/i.test(texto)) {
          melhorar.push("Nao identifiquei referencias de localizacao (distancia, bairro, pontos proximos).");
        }
      }
    }

    if (chave === "sua_propriedade") {
      if (texto) {
        if (!/wi-?fi|internet/i.test(texto)) melhorar.push("Nao menciona Wi-Fi, um dos itens mais checados antes de reservar.");
        else fortes.push("Menciona Wi-Fi.");

        if (!/\bquarto\b|\bcama\b/i.test(texto)) {
          melhorar.push("Nao descreve quantidade/tipo de quartos e camas, o hospede quer confirmar exatamente o que vai encontrar.");
        }
        if (!/cozinha/i.test(texto)) melhorar.push("Nao menciona cozinha, vale deixar claro o que esta disponivel.");

        if (/streaming/i.test(texto) && !/n[aã]o disponibilizamos|sem acesso|nao fornecemos/i.test(texto)) {
          melhorar.push("Cita streaming sem deixar claro que o login nao e disponibilizado, isso gera reclamacao. Explicite essa regra.");
        }
        if (/ar-?condicionado/i.test(texto) && /garantido|sempre funcionando|essencial/i.test(texto)) {
          melhorar.push("Evite tratar o ar-condicionado como item critico garantido, ele cobre so resfriamento e pode variar por manutencao.");
        }

        if (/\d+\s*(len[cç][oó]is?|fronhas?|toalhas?|travesseiros?)/i.test(texto)) {
          melhorar.push('Enxoval descrito como lista de itens contados (ex: "1 lencol, 1 fronha") soa como contrato de fornecimento. Prefira algo como "conta com roupa de cama e banho preparada de acordo com a capacidade da acomodacao".');
        } else if (/roupas? de cama|toalhas?|enxoval/i.test(texto)) {
          fortes.push("Deixa claro o que e fornecido em termos de enxoval, sem soar como inventario.");
        }
      }
    }

    if (chave === "acesso_hospede") {
      if (texto) {
        const checklist = [
          { re: /self[\s-]?check-?in|fechadura\s+inteligente|teclado\s+num[eé]rico|keypad|lockbox|autoatendimento/i, label: "como e o check-in (self check-in, portaria, encontro presencial)" },
          { re: /portaria/i, label: "se tem portaria e o horario dela" },
          { re: /document|identidade|identifica[cç][aã]o/i, label: "exigencia de documento" },
          { re: /elevador/i, label: "se tem elevador" },
          { re: /estacionamento|vaga/i, label: "estacionamento" },
          { re: /instru[cç][oõ]es|receber[aá]|enviamos|c[oó]digo de acesso/i, label: "como o hospede recebe as instrucoes de acesso" },
        ];
        const faltando = checklist.filter((c) => !c.re.test(texto)).map((c) => c.label);
        const presentes = checklist.filter((c) => c.re.test(texto)).map((c) => c.label);

        if (presentes.length) fortes.push(`Cobre: ${presentes.join(", ")}.`);
        if (faltando.length) {
          melhorar.push(`Antes de reservar, o hospede tambem quer saber: ${faltando.join(", ")}. Cada duvida nao respondida aqui vira pergunta por mensagem ou motivo de ansiedade na chegada.`);
        }

        if (/document/i.test(texto) && !/seguran[cç]a|identifica[cç][aã]o/i.test(texto)) {
          melhorar.push('A exigencia de documento soa como burocracia isolada. Enquadrar como seguranca muda a percepcao: "Para sua seguranca, o condominio solicita documento de identificacao na chegada" em vez de so "e necessario apresentar documento".');
        }
      }
    }

    if (chave === "interacao_hospedes") {
      if (!texto) {
        melhorar.push('Secao em branco. O hospede quer saber "se der problema, vou ficar sozinho?". Nao precisa prometer atendimento 24h, so deixar claro como funciona (ex: "atendimento remoto pelo Airbnb, disponivel durante a estadia").');
      } else {
        fortes.push("Descreve como e a interacao com os hospedes.");
        if (/sempre dispon[ií]v(el|eis)|24\s*horas|a\s+qualquer\s+momento/i.test(texto)) {
          melhorar.push('Promete disponibilidade constante ("sempre disponivel", "24 horas"). So deixe isso se for verdade, senao vira motivo de avaliacao ruim quando a resposta demorar.');
        }
        if (/whatsapp|telefone pessoal/i.test(texto)) {
          melhorar.push("Direciona para canal fora da plataforma (WhatsApp, telefone). O Airbnb considera comunicacao dentro do app como criterio de qualidade.");
        }
      }
    }

    if (chave === "outras_informacoes") {
      if (!texto) {
        melhorar.push("Vale usar essa secao para regras da casa, horario de silencio, politica de visitantes e particularidades do condominio que nao aparecem nas fotos.");
      } else {
        fortes.push("Preenchido com informacoes adicionais.");
        const { contagem, temMotivo, temCaixaAlta } = detectarLinguagemRestritiva(texto);

        if (contagem >= 3) {
          melhorar.push(`Linguagem restritiva detectada (${contagem} termos tipo "proibido"/"nao e permitido"/"multa"). Regras seguidas assim soam como regulamento extenso. Prefira a formula "REGRA + MOTIVO + ORIENTACAO", ex: em vez de "Proibido barulho apos 22h", use "Para preservar o descanso dos moradores, pedimos silencio apos as 22h".`);
        } else if (contagem > 0 && !temMotivo) {
          melhorar.push('Ha linguagem de proibicao sem explicar o motivo. Adicionar o "porque" (seguranca, convivencia, conforto) torna a regra mais aceitavel sem perder a clareza.');
        } else if (contagem > 0 && temMotivo) {
          fortes.push("Regras vem acompanhadas de motivo/contexto, isso passa mais hospitalidade que autoridade.");
        }

        if (temCaixaAlta) {
          melhorar.push('Ha palavras em CAIXA ALTA. Isso costuma soar como aviso agressivo, mesmo quando a regra e razoavel.');
        }

        if (/festas?|silencio|horario de silencio/i.test(texto)) fortes.push("Cobre regras de convivencia (festas/silencio).");
      }
    }

    return { texto, pontosFortes: fortes, pontosAMelhorar: melhorar };
  }

  const secoesTexto = separarSecoesDescricao(descricao);
  const descricaoPorSecao = {};
  ["descricao_anuncio", "sua_propriedade", "acesso_hospede", "interacao_hospedes", "outras_informacoes"].forEach((chave) => {
    descricaoPorSecao[chave] = avaliarSecao(chave, secoesTexto[chave] || "");
  });

  const NOMES_SECOES_DESCRICAO = {
    descricao_anuncio: "Descrição do anúncio",
    sua_propriedade: "Sua propriedade",
    acesso_hospede: "Acesso do hóspede",
    interacao_hospedes: "Interação com os hóspedes",
    outras_informacoes: "Outras informações importantes",
  };

  // ----- 3. Fotos -----
  const fotosPontosFortes = [];
  const fotosPontosAMelhorar = [];
  if (Number.isNaN(numFotos)) {
    fotosPontosAMelhorar.push("Numero de fotos nao informado.");
  } else if (numFotos >= 20) {
    fotosPontosFortes.push(`${numFotos} fotos, dentro da faixa recomendada pelo Airbnb (20 ou mais).`);
  } else if (numFotos >= 10) {
    fotosPontosAMelhorar.push(`${numFotos} fotos. Da para melhorar, o ideal e ter 20 ou mais cobrindo todos os comodos, detalhes e areas comuns do predio.`);
  } else {
    fotosPontosAMelhorar.push(`Apenas ${numFotos} fotos. Isso e pouco, anuncios com poucas fotos convertem menos e passam menos confianca.`);
  }

  // ----- 4. Selo Preferido dos Hospedes -----
  const REFERENCIA_NOTA_GERAL = 4.9;
  const REFERENCIA_CATEGORIA = 4.8;

  const minimoAvaliacoes = {
    valor_atual: numAvaliacoes,
    atende: numAvaliacoes >= 5,
  };

  // Sempre mostra as 6 categorias, mesmo as que nao foram informadas,
  // para deixar claro a qual nota cada linha se refere.
  const NOMES_CATEGORIAS = {
    limpeza: "Limpeza",
    exatidao: "Exatidao do anuncio",
    checkin: "Check-in",
    comunicacao: "Comunicacao",
    localizacao: "Localizacao",
    custo_beneficio: "Custo-beneficio",
  };
  const categoriasDetalhe = {};
  let todasCategoriasOk = true;
  let algumaCategoriaInformada = false;
  Object.entries(NOMES_CATEGORIAS).forEach(([chave, nome]) => {
    const bruta = categorias ? categorias[chave] : null;
    const v = paraNumero(bruta);
    if (v === null) {
      categoriasDetalhe[nome] = { valor: null, atende: null, referencia: REFERENCIA_CATEGORIA };
    } else {
      algumaCategoriaInformada = true;
      const atende = v >= REFERENCIA_CATEGORIA;
      if (!atende) todasCategoriasOk = false;
      categoriasDetalhe[nome] = { valor: v, atende, referencia: REFERENCIA_CATEGORIA };
    }
  });
  if (!algumaCategoriaInformada) todasCategoriasOk = null;

  let provavelElegivel = null;
  if (nota !== null) {
    const notaOk = nota >= REFERENCIA_NOTA_GERAL;
    const avaliacoesOk = minimoAvaliacoes.atende;
    if (todasCategoriasOk === null) {
      provavelElegivel = notaOk && avaliacoesOk ? true : notaOk === false ? false : null;
    } else {
      provavelElegivel = notaOk && avaliacoesOk && todasCategoriasOk;
    }
  }

  let observacao;
  if (provavelElegivel === true) {
    observacao = "Os numeros informados batem com o padrao observado em anuncios que carregam o selo (nota geral acima de 4,9 e categorias fortes). Isso e uma estimativa, o Airbnb tambem usa dados internos nao publicos (cancelamentos, casos de suporte).";
  } else if (provavelElegivel === false) {
    observacao = "Pelos criterios publicos, esse anuncio provavelmente ainda nao atinge o selo. O ponto de maior impacto costuma ser a nota geral, ela precisa subir para perto de 4,9 antes de qualquer outro ajuste fazer diferenca.";
  } else {
    observacao = "Nao ha dados suficientes para estimar com confianca. Preencha as notas por categoria para um diagnostico mais completo.";
  }

  const criteriosOficiais = [
    "Pelo menos 5 avaliacoes de hospedes",
    "Avaliacoes excelentes (nota geral na faixa de 4,9 ou mais, observado na pratica)",
    "Notas altas nas 6 categorias: check-in, limpeza, exatidao, comunicacao, localizacao e custo-beneficio",
    "Baixa taxa de cancelamento do anfitriao e poucos casos de suporte por qualidade (em torno de 1% em media, dado interno do Airbnb)",
    "Comunicacao entre hospede e anfitriao feita dentro da plataforma",
  ];

  return res.json({
    avaliacoes_necessarias: avaliacoesNecessarias,
    descricao: { secoes: descricaoPorSecao, nomesSecoes: NOMES_SECOES_DESCRICAO },
    fotos: { pontosFortes: fotosPontosFortes, pontosAMelhorar: fotosPontosAMelhorar },
    selo_preferido_hospedes: {
      provavel_elegivel_pelos_criterios_publicos: provavelElegivel,
      minimo_5_avaliacoes: minimoAvaliacoes,
      categorias_detalhe: categoriasDetalhe,
      observacao,
      criterios_oficiais: criteriosOficiais,
    },
  });
});

// ---------- ROTA 3: Sugerir titulos melhores (Gemini, gratis) ----------

app.post("/api/sugerir-titulos", async (req, res) => {
  try {
    const { tituloAtual, descricao } = req.body || {};

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: "Chave da API do Gemini nao encontrada. Confira o arquivo .env na pasta do projeto." });
    }

    const prompt =
      "Voce e um especialista em copywriting para anuncios de aluguel por temporada no Airbnb Brasil. " +
      `O titulo atual do anuncio e: "${tituloAtual || "(nao informado)"}". ` +
      `A descricao do anuncio e:\n"""${(descricao || "").slice(0, 2000)}"""\n\n` +
      "De 5 sugestoes de titulo MELHORES que esse. Regras obrigatorias: " +
      "cada titulo deve ter NO MAXIMO 50 caracteres (limite do Airbnb, conte os caracteres com cuidado), " +
      "deve destacar o principal diferencial do imovel (localizacao, vista, tipo de espaco, publico-alvo), " +
      "sem exagero nem clickbait, sem emojis, em portugues do Brasil. " +
      "Responda APENAS com os 5 titulos, um por linha, sem numeracao, sem aspas, sem texto explicativo antes ou depois.";

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
    return res.status(500).json({ error: "Erro interno ao gerar sugestoes: " + err.message });
  }
});

// ---------- ROTA 4: Analisar fotos com IA (Gemini, gratis) ----------

app.post("/api/analisar-fotos", async (req, res) => {
  try {
    const { fotos } = req.body || {};

    if (!fotos || !Array.isArray(fotos) || !fotos.length) {
      return res.status(400).json({
        error: "Nenhuma foto disponivel para analisar. Essa funcao so funciona depois de uma busca automatica bem-sucedida (Passo 1), que traz os links reais das fotos.",
      });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        error: "Chave da API do Gemini nao encontrada. Confira o arquivo .env na pasta do projeto.",
      });
    }

    const LIMITE_FOTOS = 40; // cobre praticamente qualquer anuncio real
    const fotosParaAnalisar = fotos.slice(0, LIMITE_FOTOS);
    const resultados = [];
    let cotaEstourada = false;

    for (const url of fotosParaAnalisar) {
      if (cotaEstourada) {
        resultados.push({ url, analise: null, erro: "Nao analisada: cota gratuita do Gemini foi atingida nesta rodada." });
        continue;
      }

      try {
        // Alguns CDNs (incluindo o do Airbnb) bloqueiam downloads sem
        // Referer/User-Agent parecido com navegador de verdade.
        const imgRes = await fetch(url, {
          headers: {
            Referer: "https://www.airbnb.com.br/",
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          },
        });
        if (!imgRes.ok) throw new Error(`Nao foi possivel baixar a foto (HTTP ${imgRes.status}).`);
        const buffer = Buffer.from(await imgRes.arrayBuffer());
        const mimeType = imgRes.headers.get("content-type") || "image/jpeg";
        const base64 = buffer.toString("base64");

        const prompt =
          "Voce e um especialista em fotografia para anuncios de aluguel por temporada (Airbnb) no Brasil. " +
          "Olhe esta foto e responda em portugues, em no maximo 2 frases curtas e diretas: " +
          "(1) o que essa foto transmite bem para quem esta decidindo reservar, e " +
          "(2) uma sugestao pratica e especifica de melhoria, se houver alguma. " +
          "Nao use elogios genericos, seja concreto.";

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
          const msgErro = data?.error?.message || "Erro desconhecido na API do Gemini.";
          if (geminiRes.status === 429 || status === "RESOURCE_EXHAUSTED") {
            cotaEstourada = true;
            resultados.push({ url, analise: null, erro: "Cota gratuita do Gemini atingida (limite por minuto ou por dia). As fotos restantes nao foram analisadas nesta rodada." });
          } else {
            resultados.push({ url, analise: null, erro: msgErro });
          }
        } else {
          const texto = data?.candidates?.[0]?.content?.parts?.[0]?.text;
          resultados.push({ url, analise: texto ? texto.trim() : null, erro: texto ? null : "Sem resposta da IA para esta foto." });
        }
      } catch (err) {
        resultados.push({ url, analise: null, erro: err.message });
      }

      // Respeita o limite da cota gratuita do Gemini (poucas requisicoes por minuto).
      await new Promise((r) => setTimeout(r, 4500));
    }

    return res.json({ resultados, total_analisadas: resultados.length, total_disponivel: fotos.length, cota_estourada: cotaEstourada });
  } catch (err) {
    console.error("Erro em /api/analisar-fotos:", err);
    return res.status(500).json({ error: "Erro interno ao analisar as fotos: " + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando! Abra o navegador em: http://localhost:${PORT}`);
});
