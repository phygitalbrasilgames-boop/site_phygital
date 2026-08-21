/* ==========================================================================
   PHYGITAL BRASIL — MENSAGENS DA API EM OUTRO IDIOMA

   As mensagens de erro da API não são código de erro: são texto para humano,
   e o front-end as joga direto num toast. Um competidor com o site em inglês
   que recebe "E-mail ou senha incorretos." vê meia tela traduzida.

   O dicionário é INDEXADO PELO TEXTO EM PORTUGUÊS, a mesma escolha do
   front-end (site/assets/js/i18n.js). A consequência prática é que nenhum
   `throw erro400('...')` precisa mudar: quem traduz é a saída, em
   server/http.js → falha(). Trocar o português de uma mensagem sem trocar a
   chave aqui apenas devolve o português — nunca quebra.

   COBERTURA PARCIAL, DE PROPÓSITO. Estão aqui as mensagens de autenticação e
   de inscrição (as que o usuário final mais vê) e as genéricas de HTTP. As
   demais áreas continuam em português até serem acrescentadas; o mecanismo já
   está pronto para elas.
   ========================================================================== */
'use strict';

const traducoes = require('./traducoes');

/* --------------------------------------------------------------------------
   TEXTO EXATO
   -------------------------------------------------------------------------- */

const DICIONARIO = {
  /* --- HTTP e sessão ----------------------------------------------------- */
  'Faça login para continuar.': {
    en: 'Sign in to continue.',
    es: 'Inicia sesión para continuar.'
  },
  'Sua conta não tem permissão para esta ação.': {
    en: 'Your account is not allowed to do this.',
    es: 'Tu cuenta no tiene permiso para esta acción.'
  },
  'Esta área é do Painel do Competidor.': {
    en: 'This area belongs to the Competitor Panel.',
    es: 'Esta área es del Panel del Competidor.'
  },
  'Esta área é do Painel do Administrador.': {
    en: 'This area belongs to the Admin Panel.',
    es: 'Esta área es del Panel del Administrador.'
  },
  'Não encontrado.': { en: 'Not found.', es: 'No encontrado.' },
  'Erro interno no servidor.': {
    en: 'Internal server error.',
    es: 'Error interno del servidor.'
  },
  'Muitas requisições. Tente de novo em instantes.': {
    en: 'Too many requests. Try again in a moment.',
    es: 'Demasiadas solicitudes. Inténtalo de nuevo en un momento.'
  },
  'Conteúdo enviado é grande demais.': {
    en: 'The content you sent is too large.',
    es: 'El contenido enviado es demasiado grande.'
  },
  'JSON inválido no corpo da requisição.': {
    en: 'Invalid JSON in the request body.',
    es: 'JSON inválido en el cuerpo de la solicitud.'
  },
  'O corpo da requisição deve ser um objeto JSON.': {
    en: 'The request body must be a JSON object.',
    es: 'El cuerpo de la solicitud debe ser un objeto JSON.'
  },
  'Origem inválida.': { en: 'Invalid origin.', es: 'Origen inválido.' },
  'Requisição cruzada bloqueada.': {
    en: 'Cross-site request blocked.',
    es: 'Solicitud entre sitios bloqueada.'
  },
  'Sessão não encontrada.': { en: 'Session not found.', es: 'Sesión no encontrada.' },
  'Identificador de sessão inválido.': {
    en: 'Invalid session identifier.',
    es: 'Identificador de sesión inválido.'
  },

  /* --- Login, cadastro e senha ------------------------------------------- */
  'E-mail ou senha incorretos.': {
    en: 'Wrong e-mail or password.',
    es: 'Correo o contraseña incorrectos.'
  },
  'A senha atual não confere.': {
    en: 'The current password does not match.',
    es: 'La contraseña actual no coincide.'
  },
  'A nova senha precisa ser diferente da atual.': {
    en: 'The new password must be different from the current one.',
    es: 'La nueva contraseña debe ser diferente de la actual.'
  },
  'A nova senha precisa ser diferente da provisória.': {
    en: 'The new password must be different from the temporary one.',
    es: 'La nueva contraseña debe ser diferente de la provisional.'
  },
  'A senha escolhida não atende aos requisitos.': {
    en: 'The chosen password does not meet the requirements.',
    es: 'La contraseña elegida no cumple los requisitos.'
  },
  'Informe uma senha.': { en: 'Enter a password.', es: 'Introduce una contraseña.' },
  'Informe um e-mail válido.': {
    en: 'Enter a valid e-mail address.',
    es: 'Introduce un correo electrónico válido.'
  },
  'Informe o seu nome completo.': {
    en: 'Enter your full name.',
    es: 'Introduce tu nombre completo.'
  },
  'Já existe uma conta com este e-mail.': {
    en: 'An account with this e-mail already exists.',
    es: 'Ya existe una cuenta con este correo.'
  },
  'O novo e-mail é igual ao atual.': {
    en: 'The new e-mail is the same as the current one.',
    es: 'El nuevo correo es igual al actual.'
  },
  'Esta conta já tem senha definitiva. Entre normalmente ou use "Esqueci minha senha".': {
    en: 'This account already has a permanent password. Sign in normally or use "Forgot my password".',
    es: 'Esta cuenta ya tiene contraseña definitiva. Inicia sesión normalmente o usa "Olvidé mi contraseña".'
  },
  'Muitas tentativas. Aguarde alguns minutos e tente novamente.': {
    en: 'Too many attempts. Wait a few minutes and try again.',
    es: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.'
  },

  /* --- Códigos de verificação -------------------------------------------- */
  'Nenhum código pendente. Peça um novo.': {
    en: 'No pending code. Request a new one.',
    es: 'No hay código pendiente. Solicita uno nuevo.'
  },
  'O código expirou. Peça um novo.': {
    en: 'The code has expired. Request a new one.',
    es: 'El código ha caducado. Solicita uno nuevo.'
  },
  'Muitas tentativas. Peça um novo código.': {
    en: 'Too many attempts. Request a new code.',
    es: 'Demasiados intentos. Solicita un código nuevo.'
  },
  'Código incorreto. Peça um novo código.': {
    en: 'Wrong code. Request a new code.',
    es: 'Código incorrecto. Solicita un código nuevo.'
  },
  'Finalidade de código desconhecida.': {
    en: 'Unknown code purpose.',
    es: 'Finalidad de código desconocida.'
  },
  'Não há alteração pendente para confirmar.': {
    en: 'There is no pending change to confirm.',
    es: 'No hay ningún cambio pendiente por confirmar.'
  },
  'A troca pendente não é mais válida. Peça a alteração de novo.': {
    en: 'The pending change is no longer valid. Request it again.',
    es: 'El cambio pendiente ya no es válido. Solicítalo de nuevo.'
  },

  /* --- Inscrição --------------------------------------------------------- */
  'Campeonato não encontrado.': {
    en: 'Championship not found.',
    es: 'Campeonato no encontrado.'
  },
  'Time não encontrado.': { en: 'Team not found.', es: 'Equipo no encontrado.' },
  'Inscrição não encontrada.': {
    en: 'Registration not found.',
    es: 'Inscripción no encontrada.'
  },
  'Esta inscrição pertence a outra conta.': {
    en: 'This registration belongs to another account.',
    es: 'Esta inscripción pertenece a otra cuenta.'
  },
  'Este time pertence a outra conta.': {
    en: 'This team belongs to another account.',
    es: 'Este equipo pertenece a otra cuenta.'
  },
  'A inscrição perdeu o vínculo com o time ou com o campeonato.': {
    en: 'The registration lost its link to the team or to the championship.',
    es: 'La inscripción perdió el vínculo con el equipo o con el campeonato.'
  },
  'Informe o campeonato (campeonatoId) e o time (timeId).': {
    en: 'Provide the championship (campeonatoId) and the team (timeId).',
    es: 'Indica el campeonato (campeonatoId) y el equipo (timeId).'
  },
  'Explique em "observacao" o motivo do cancelamento.': {
    en: 'Explain the reason for the cancellation in "observacao".',
    es: 'Explica en "observacao" el motivo de la cancelación.'
  },
  'As inscrições não estão abertas.': {
    en: 'Registrations are not open.',
    es: 'Las inscripciones no están abiertas.'
  }
};

/* --------------------------------------------------------------------------
   TEXTO COM VALOR NO MEIO

   Estas mensagens carregam nome de time, data ou contagem. O que a expressão
   captura entra de volta no molde na ordem em que apareceu ({0}, {1}, ...).
   A ordem da lista importa: a primeira que casar é a usada.
   -------------------------------------------------------------------------- */

const PADROES = [
  {
    re: /^Código incorreto\. (\d+) tentativa\(s\) restante\(s\)\.$/,
    en: 'Wrong code. {0} attempt(s) left.',
    es: 'Código incorrecto. Quedan {0} intento(s).'
  },
  {
    re: /^Muitas tentativas\. Aguarde (\d+) minutos e tente novamente\.$/,
    en: 'Too many attempts. Wait {0} minutes and try again.',
    es: 'Demasiados intentos. Espera {0} minutos e inténtalo de nuevo.'
  },
  {
    re: /^As inscrições abrem em (.+)\.$/,
    en: 'Registrations open on {0}.',
    es: 'Las inscripciones abren el {0}.'
  },
  {
    re: /^As inscrições encerraram em (.+)\.$/,
    en: 'Registrations closed on {0}.',
    es: 'Las inscripciones cerraron el {0}.'
  },
  {
    /* O nome do campeonato vem traduzido? Não: a mensagem é montada com o
       português da linha. Traduzir o miolo exigiria refazer a mensagem na
       rota; aqui só a moldura muda, que já é o que o usuário precisa entender. */
    re: /^(.+) já está inscrito em (.+) \(protocolo (.+)\)\.$/,
    en: '{0} is already registered in {1} (protocol {2}).',
    es: '{0} ya está inscrito en {1} (protocolo {2}).'
  },
  {
    re: /^O elenco de (.+) não atende às regras de (.+)\.$/,
    en: 'The roster of {0} does not meet the {1} rules.',
    es: 'La plantilla de {0} no cumple las reglas de {1}.'
  },
  {
    re: /^Status inválido: (.+)\. Use triagem, oficial, espera ou cancelada\.$/,
    en: 'Invalid status: {0}. Use triagem, oficial, espera or cancelada.',
    es: 'Estado inválido: {0}. Usa triagem, oficial, espera o cancelada.'
  },
  {
    re: /^Seu nível de acesso \((.+)\) não permite: (.+)\.$/,
    en: 'Your access level ({0}) does not allow: {1}.',
    es: 'Tu nivel de acceso ({0}) no permite: {1}.'
  },
  {
    re: /^As inscrições já foram encerradas em: (.+)\. Qualquer alteração agora precisa passar por um chamado\.$/,
    en: 'Registrations already closed for: {0}. Any change now has to go through a support ticket.',
    es: 'Las inscripciones ya cerraron en: {0}. Cualquier cambio ahora debe pasar por un ticket.'
  }
];

/* --------------------------------------------------------------------------
   TRADUÇÃO
   -------------------------------------------------------------------------- */

/**
 * Traduz uma mensagem da API. Sem entrada no dicionário, devolve o original:
 * português é melhor que lacuna, e é o que garante que uma mensagem nova nunca
 * derrube a resposta.
 */
function traduzir(texto, idioma) {
  const alvo = traducoes.normalizar(idioma);
  if (!alvo || alvo === traducoes.IDIOMA_PADRAO) return texto;
  if (texto === null || texto === undefined) return texto;

  const original = String(texto);

  const exato = DICIONARIO[original];
  if (exato && exato[alvo]) return exato[alvo];

  for (const padrao of PADROES) {
    const casou = padrao.re.exec(original);
    if (!casou) continue;
    const molde = padrao[alvo];
    if (!molde) continue;
    return molde.replace(/\{(\d+)\}/g, (_, i) => {
      const valor = casou[Number(i) + 1];
      return valor === undefined ? '' : valor;
    });
  }

  return original;
}

/** Quantas mensagens o dicionário cobre. Usado no relatório e nos testes. */
function cobertura() {
  return { exatas: Object.keys(DICIONARIO).length, padroes: PADROES.length };
}

module.exports = { traduzir, cobertura, DICIONARIO, PADROES };
