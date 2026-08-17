/* ==========================================================================
   PHYGITAL BRASIL — EXPORTAÇÃO
   Gera o .zip do campeonato (ou de um time) direto no navegador, sem
   biblioteca externa: escritor ZIP próprio no método "store" (sem compressão)
   e planilha .xlsx montada como XML dentro do próprio zip.

   Estrutura, conforme o briefing:
     <Campeonato>/<Time>/<Time>.svg              → logo nomeado com o time
     <Campeonato>/<Time>/<Nome do Jogador>.svg   → foto nomeada com o jogador
     <Campeonato>/<Campeonato>.xlsx              → uma página por time
   Em campeonatos de Dança não há pasta por atleta: fotos soltas e uma única
   página na planilha.
   ========================================================================== */
(function (global) {
  'use strict';

  /* ---------------------------------------------------------------------
     CRC32 — exigido pelo formato ZIP
     --------------------------------------------------------------------- */
  var TABELA_CRC = (function () {
    var t = new Uint32Array(256);
    for (var i = 0; i < 256; i++) {
      var c = i;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) {
      c = TABELA_CRC[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  var codificador = new TextEncoder();
  function texto(s) { return codificador.encode(s); }

  /* ---------------------------------------------------------------------
     ESCRITOR ZIP
     --------------------------------------------------------------------- */
  function criarZip() {
    var itens = [];
    return {
      add: function (caminho, conteudo) {
        var bytes = typeof conteudo === 'string' ? texto(conteudo) : new Uint8Array(conteudo);
        itens.push({ nome: caminho, dados: bytes, crc: crc32(bytes) });
      },
      gerar: function () {
        var partes = [], central = [], offset = 0;

        itens.forEach(function (it) {
          var nome = texto(it.nome);
          var cab = new Uint8Array(30 + nome.length);
          var v = new DataView(cab.buffer);
          v.setUint32(0, 0x04034b50, true);   /* assinatura local */
          v.setUint16(4, 20, true);           /* versão mínima */
          v.setUint16(6, 0x0800, true);       /* flag UTF-8 nos nomes */
          v.setUint16(8, 0, true);            /* método 0 = store */
          v.setUint16(10, 0, true);           /* hora */
          v.setUint16(12, 0x2821, true);      /* data fixa (2020-01-01) */
          v.setUint32(14, it.crc, true);
          v.setUint32(18, it.dados.length, true);
          v.setUint32(22, it.dados.length, true);
          v.setUint16(26, nome.length, true);
          v.setUint16(28, 0, true);
          cab.set(nome, 30);

          partes.push(cab, it.dados);

          var cd = new Uint8Array(46 + nome.length);
          var cv = new DataView(cd.buffer);
          cv.setUint32(0, 0x02014b50, true);  /* assinatura central */
          cv.setUint16(4, 20, true);
          cv.setUint16(6, 20, true);
          cv.setUint16(8, 0x0800, true);
          cv.setUint16(10, 0, true);
          cv.setUint16(12, 0, true);
          cv.setUint16(14, 0x2821, true);
          cv.setUint32(16, it.crc, true);
          cv.setUint32(20, it.dados.length, true);
          cv.setUint32(24, it.dados.length, true);
          cv.setUint16(28, nome.length, true);
          cv.setUint32(42, offset, true);
          cd.set(nome, 46);
          central.push(cd);

          offset += cab.length + it.dados.length;
        });

        var tamCentral = central.reduce(function (n, c) { return n + c.length; }, 0);
        var fim = new Uint8Array(22);
        var fv = new DataView(fim.buffer);
        fv.setUint32(0, 0x06054b50, true);
        fv.setUint16(8, itens.length, true);
        fv.setUint16(10, itens.length, true);
        fv.setUint32(12, tamCentral, true);
        fv.setUint32(16, offset, true);

        return new Blob(partes.concat(central, [fim]), { type: 'application/zip' });
      }
    };
  }

  /* ---------------------------------------------------------------------
     PLANILHA .XLSX (uma aba por time)
     --------------------------------------------------------------------- */
  function escXml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }

  function colunaLetra(n) {
    var s = '';
    while (n >= 0) { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; }
    return s;
  }

  function aba(linhas) {
    var xml = '<?xml version="1.0" encoding="UTF-8"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';
    linhas.forEach(function (linha, i) {
      xml += '<row r="' + (i + 1) + '">';
      linha.forEach(function (celula, j) {
        xml += '<c r="' + colunaLetra(j) + (i + 1) + '" t="inlineStr"><is><t xml:space="preserve">' +
               escXml(celula) + '</t></is></c>';
      });
      xml += '</row>';
    });
    return xml + '</sheetData></worksheet>';
  }

  /* Nome de aba do Excel: máx. 31 caracteres e sem : \ / ? * [ ] */
  function nomeAba(nome, usados) {
    var limpo = String(nome).replace(/[:\\\/\?\*\[\]]/g, '-').substring(0, 31) || 'Planilha';
    var base = limpo, n = 2;
    while (usados[limpo]) { limpo = (base.substring(0, 28) + '-' + n).substring(0, 31); n++; }
    usados[limpo] = true;
    return limpo;
  }

  function montarXlsx(abas) {
    var zip = criarZip();
    var usados = {};
    var nomes = abas.map(function (a) { return nomeAba(a.nome, usados); });

    zip.add('[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      abas.map(function (a, i) {
        return '<Override PartName="/xl/worksheets/sheet' + (i + 1) +
               '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
      }).join('') +
      '</Types>');

    zip.add('_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>');

    zip.add('xl/workbook.xml',
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      nomes.map(function (n, i) {
        return '<sheet name="' + escXml(n) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>';
      }).join('') +
      '</sheets></workbook>');

    zip.add('xl/_rels/workbook.xml.rels',
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      abas.map(function (a, i) {
        return '<Relationship Id="rId' + (i + 1) +
               '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' +
               (i + 1) + '.xml"/>';
      }).join('') +
      '</Relationships>');

    abas.forEach(function (a, i) {
      zip.add('xl/worksheets/sheet' + (i + 1) + '.xml', aba(a.linhas));
    });

    return zip.gerar();
  }

  /* ---------------------------------------------------------------------
     APOIO
     --------------------------------------------------------------------- */
  function seguro(nome) {
    /* Nome de arquivo legível: mantém acentos, tira o que o sistema recusa */
    return String(nome || 'sem-nome').replace(/[\/\\:\*\?"<>\|]/g, '-').trim();
  }

  function baixar(blob, nomeArquivo) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = nomeArquivo;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function buscarBinario(caminho) {
    return fetch(caminho)
      .then(function (r) { return r.ok ? r.arrayBuffer() : null; })
      .catch(function () { return null; });
  }

  var CABECALHO_JOGADOR = ['Nome', 'Apelido', 'E-mail', 'Telefone', 'Nascimento',
                           'Nº camisa', 'Função', 'Steam64', 'Faceit', 'Instagram', 'Tipo'];

  function linhasDoTime(time) {
    var linhas = [CABECALHO_JOGADOR];
    (time.jogadores || []).forEach(function (j) {
      linhas.push([j.nome, j.apelido || '', j.email || '', j.tel || '', j.nasc || '',
                   j.numero || '', j.funcao || '', j.steam || '', j.faceit || '',
                   j.insta || '', j.reserva ? 'Reserva' : 'Titular']);
    });
    if ((time.staff || []).length) {
      linhas.push([]);
      linhas.push(['COMISSÃO TÉCNICA']);
      linhas.push(['Nome', 'Função', 'E-mail', 'Telefone', 'Nascimento', 'Instagram']);
      time.staff.forEach(function (s) {
        linhas.push([s.nome, s.papel || '', s.email || '', s.tel || '', s.nasc || '', s.insta || '']);
      });
    }
    return linhas;
  }

  /* ---------------------------------------------------------------------
     API PÚBLICA
     --------------------------------------------------------------------- */
  var api = {
    /**
     * Exporta um campeonato inteiro.
     * @param {object} campeonato  registro de PB.dados.campeonato()
     * @param {array}  times       lista de times a incluir
     */
    campeonato: function (campeonato, times) {
      var ehDanca = campeonato.modalidade === 'dance';
      var pastaRaiz = seguro(campeonato.nome);
      var zip = criarZip();

      var pendentes = [];

      times.forEach(function (time, indiceTime) {
        var nomeTime = seguro(time.nome);
        /* Dança: fotos soltas, sem pasta por atleta (exceção do briefing) */
        var pasta = ehDanca ? pastaRaiz + '/Fotos' : pastaRaiz + '/' + nomeTime;

        if (!ehDanca) {
          pendentes.push(
            buscarBinario('../assets/img/mock/escudo-' + ((indiceTime % 12) + 1) + '.svg')
              .then(function (b) { if (b) zip.add(pasta + '/' + nomeTime + '.svg', b); }));
        }

        (time.jogadores || []).forEach(function (j, k) {
          pendentes.push(
            buscarBinario('../assets/img/mock/jogador-' + ((k % 8) + 1) + '.svg')
              .then(function (b) { if (b) zip.add(pasta + '/' + seguro(j.nome) + '.svg', b); }));
        });
      });

      return Promise.all(pendentes).then(function () {
        var abas;
        if (ehDanca) {
          /* Uma única página com todos os atletas */
          var linhas = [CABECALHO_JOGADOR.concat(['Atleta/Time'])];
          times.forEach(function (t) {
            (t.jogadores || []).forEach(function (j) {
              linhas.push([j.nome, j.apelido || '', j.email || '', j.tel || '', j.nasc || '',
                           j.numero || '', j.funcao || '', j.steam || '', j.faceit || '',
                           j.insta || '', t.nome]);
            });
          });
          abas = [{ nome: 'Atletas', linhas: linhas }];
        } else {
          abas = times.map(function (t) { return { nome: t.nome, linhas: linhasDoTime(t) }; });
        }

        return montarXlsx(abas).arrayBuffer().then(function (buf) {
          zip.add(pastaRaiz + '/' + pastaRaiz + '.xlsx', buf);
          baixar(zip.gerar(), pastaRaiz + '.zip');
          return { arquivos: times.length, danca: ehDanca };
        });
      });
    },

    /** Exporta um único time. */
    time: function (campeonato, time, indice) {
      var ehDanca = campeonato.modalidade === 'dance';
      var nomeTime = seguro(time.nome);
      var zip = criarZip();
      var pasta = ehDanca ? 'Fotos' : nomeTime;
      var pendentes = [];

      if (!ehDanca) {
        pendentes.push(
          buscarBinario('../assets/img/mock/escudo-' + (((indice || 0) % 12) + 1) + '.svg')
            .then(function (b) { if (b) zip.add(pasta + '/' + nomeTime + '.svg', b); }));
      }
      (time.jogadores || []).forEach(function (j, k) {
        pendentes.push(
          buscarBinario('../assets/img/mock/jogador-' + ((k % 8) + 1) + '.svg')
            .then(function (b) { if (b) zip.add(pasta + '/' + seguro(j.nome) + '.svg', b); }));
      });

      return Promise.all(pendentes).then(function () {
        return montarXlsx([{ nome: time.nome, linhas: linhasDoTime(time) }])
          .arrayBuffer().then(function (buf) {
            zip.add(pasta + '/' + nomeTime + '.xlsx', buf);
            baixar(zip.gerar(), nomeTime + '.zip');
            return { arquivos: 1, danca: ehDanca };
          });
      });
    }
  };

  global.PB = global.PB || {};
  global.PB.exportar = api;
})(window);
