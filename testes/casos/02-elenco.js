/* ==========================================================================
   ELENCO — os limites de cada modalidade

   O briefing define uma faixa diferente por modalidade, e ela é a regra que
   mais custa caro se estiver errada: um time entra no campeonato com gente a
   menos, ou é barrado tendo direito de jogar.

   validarElenco recebe CONTAGENS (titulares, reservas) e não listas — é a
   mesma assinatura do front-end, para os dois lados usarem o mesmo teste.
   ========================================================================== */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const amb = require('../apoio/ambiente');

const { validarElenco, MODALIDADES } = amb.regras;

/* --------------------------------------------------------------------------
   OS 14 CASOS-LIMITE

   Cada linha é uma fronteira: o valor imediatamente antes do mínimo, o mínimo
   exato, o máximo exato, o primeiro valor acima do máximo e o teto de reservas.
   -------------------------------------------------------------------------- */

const LIMITES = [
  /* futebol: 6 a 8 titulares, até 3 reservas */
  { n: 1, mod: 'futebol', tit: 5, res: 0, valido: false, porque: 'um abaixo do mínimo de 6' },
  { n: 2, mod: 'futebol', tit: 6, res: 0, valido: true, porque: 'mínimo exato' },
  { n: 3, mod: 'futebol', tit: 8, res: 3, valido: true, porque: 'teto exato de titulares e de reservas' },
  { n: 4, mod: 'futebol', tit: 9, res: 0, valido: false, porque: 'um acima do máximo de 8' },
  { n: 5, mod: 'futebol', tit: 6, res: 4, valido: false, porque: 'uma reserva além das 3' },

  /* basquete: 3 a 4 titulares, até 2 reservas */
  { n: 6, mod: 'basquete', tit: 2, res: 0, valido: false, porque: 'um abaixo do mínimo de 3' },
  { n: 7, mod: 'basquete', tit: 3, res: 2, valido: true, porque: 'mínimo exato com as 2 reservas' },
  { n: 8, mod: 'basquete', tit: 5, res: 0, valido: false, porque: 'um acima do máximo de 4' },

  /* shooter: exatamente 5 titulares, até 3 reservas */
  { n: 9, mod: 'shooter', tit: 4, res: 0, valido: false, porque: 'shooter não joga com 4' },
  { n: 10, mod: 'shooter', tit: 5, res: 3, valido: true, porque: 'os 5 exatos com as 3 reservas' },
  { n: 11, mod: 'shooter', tit: 5, res: 4, valido: false, porque: 'uma reserva além das 3' },

  /* dance: atleta solo, sem reserva */
  { n: 12, mod: 'dance', tit: 1, res: 0, valido: true, porque: 'o atleta solo' },
  { n: 13, mod: 'dance', tit: 1, res: 1, valido: false, porque: 'dança não tem reserva' },
  { n: 14, mod: 'dance', tit: 2, res: 0, valido: false, porque: 'dança é individual' }
];

describe('elenco', () => {
  describe('os 14 casos-limite de validarElenco', () => {
    for (const caso of LIMITES) {
      const rotulo = `${String(caso.n).padStart(2, '0')}. ${caso.mod} `
        + `${caso.tit}+${caso.res} → ${caso.valido ? 'válido' : 'inválido'} (${caso.porque})`;

      it(rotulo, () => {
        const r = validarElenco(caso.mod, caso.tit, caso.res);

        assert.equal(r.valido, caso.valido);
        assert.equal(r.erros.length === 0, caso.valido);
        if (!caso.valido) {
          assert.ok(r.erros.every((e) => typeof e === 'string' && e.length > 0));
        }
      });
    }
  });

  it('a faixa de cada modalidade é a do briefing', () => {
    /* Se alguém afrouxar um limite sem querer, é aqui que aparece. */
    const esperado = {
      futebol: { jogadoresMin: 6, jogadoresMax: 8, reservasMax: 3, staffMax: 3 },
      basquete: { jogadoresMin: 3, jogadoresMax: 4, reservasMax: 2, staffMax: 2 },
      shooter: { jogadoresMin: 5, jogadoresMax: 5, reservasMax: 3, staffMax: 1 },
      dance: { jogadoresMin: 1, jogadoresMax: 1, reservasMax: 0, staffMax: 1 }
    };

    for (const [id, faixa] of Object.entries(esperado)) {
      for (const [campo, valor] of Object.entries(faixa)) {
        assert.equal(MODALIDADES[id][campo], valor, `${id}.${campo}`);
      }
    }
  });

  it('modalidade desconhecida cai na faixa larga de "outros"', () => {
    /* modalidade() nunca devolve undefined: uma chave errada não pode derrubar
       a validação, só deixá-la permissiva. */
    assert.equal(validarElenco('volei', 1, 0).valido, true);
    assert.equal(validarElenco('volei', 13, 0).valido, false);
    assert.equal(validarElenco('outros', 12, 3).valido, true);
  });

  it('contagem não numérica é tratada como zero, não como erro de execução', () => {
    assert.equal(validarElenco('futebol', undefined, undefined).valido, false);
    assert.equal(validarElenco('futebol', null, 'abc').valido, false);
    assert.equal(validarElenco('dance', '1', '0').valido, true);
  });

  it('o erro diz quantos jogadores faltam', () => {
    const r = validarElenco('futebol', 4, 0);
    assert.match(r.erros[0], /Faltam 2\./);
  });

  it('GET /api/times/:id/elenco aplica a mesma regra no time semeado', async () => {
    const r = await amb.comoCompetidor().get(`/api/times/${amb.SEMEADOS.timeFutebol}/elenco`);

    assert.equal(r.status, 200);
    assert.equal(r.corpo.valido, true);
    assert.equal(r.corpo.titulares, 6);
    assert.equal(r.corpo.reservas, 1);
    assert.equal(r.corpo.limites.jogadoresMin, 6);
    assert.equal(r.corpo.limites.jogadoresMax, 8);

    /* O que a rota devolve tem que bater com a função pura. */
    const puro = validarElenco('futebol', r.corpo.titulares, r.corpo.reservas);
    assert.equal(r.corpo.valido, puro.valido);
  });

  it('elenco incompleto é reprovado pela rota com a mesma lista de erros', async () => {
    const dono = amb.novoCompetidor('Dono do Elenco Curto');
    const time = await amb.novoTime(dono.cliente, { modalidade: 'shooter', titulares: 2 });

    const r = await dono.cliente.get(`/api/times/${time.id}/elenco`);

    assert.equal(r.status, 200);
    assert.equal(r.corpo.valido, false);
    assert.equal(r.corpo.titulares, 2);
    assert.deepEqual(r.corpo.erros, validarElenco('shooter', 2, 0).erros);
  });
});
