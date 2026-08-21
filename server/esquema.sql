-- ============================================================================
-- PHYGITAL BRASIL — ESQUEMA DO BANCO
--
-- SQLite via node:sqlite (embutido no Node 22.5+). Sem dependência externa.
--
-- Convenções:
--   · ids de negócio são TEXT (mantêm os mesmos ids da semente: 'cbf-2026', 't1'…)
--     para que o front-end continue funcionando sem reescrita;
--   · datas em ISO 8601 (TEXT) — o SQLite não tem tipo de data e ISO ordena
--     corretamente como string;
--   · booleanos em INTEGER 0/1;
--   · campos que o briefing trata como estrutura livre (premiação, classificação)
--     ficam em TEXT com JSON — são lidos e escritos inteiros, nunca consultados
--     por dentro;
--   · exclusão é lógica (arquivado_em) em tudo que o admin pode "arquivar",
--     espelhando arquivar/restaurar/excluirDefinitivo do front-end.
-- ============================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- CONTAS E SEGURANÇA
-- ---------------------------------------------------------------------------

-- Uma conta serve aos dois painéis; papel + nivel decidem o destino e o acesso.
CREATE TABLE IF NOT EXISTS contas (
  id                TEXT PRIMARY KEY,
  nome              TEXT NOT NULL,
  email             TEXT NOT NULL,
  telefone          TEXT,
  -- painel/conta.html tem campo de data de nascimento no formulário do perfil
  nasc              TEXT,
  -- scrypt: o hash e o sal ficam separados, nunca a senha
  senha_hash        TEXT NOT NULL,
  senha_salt        TEXT NOT NULL,
  papel             TEXT NOT NULL CHECK (papel IN ('competidor', 'admin')),
  -- só para papel='admin': master (tudo) | gestor (leitura + export + email) | operacao
  nivel             TEXT CHECK (nivel IN ('master', 'gestor', 'operacao')),
  -- idioma preferido da conta: vale para o painel e para o e-mail que ela
  -- recebe. Valores em server/traducoes.js (pt | en | es).
  idioma            TEXT NOT NULL DEFAULT 'pt' CHECK (idioma IN ('pt', 'en', 'es')),
  email_verificado  INTEGER NOT NULL DEFAULT 0,
  -- admin criado pelo master recebe senha temporária e é obrigado a trocar
  senha_provisoria  INTEGER NOT NULL DEFAULT 0,
  criado_em         TEXT NOT NULL,
  atualizado_em     TEXT,
  ultimo_acesso_em  TEXT,
  arquivado_em      TEXT
);

-- E-mail único ignorando maiúsculas: o login normaliza para minúsculas.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contas_email ON contas (lower(email));

-- Sessões ficam no banco para poder revogar. Guarda o HASH do token: um vazamento
-- da tabela não permite assumir a sessão.
CREATE TABLE IF NOT EXISTS sessoes (
  token_hash    TEXT PRIMARY KEY,
  conta_id      TEXT NOT NULL REFERENCES contas (id) ON DELETE CASCADE,
  criado_em     TEXT NOT NULL,
  expira_em     TEXT NOT NULL,
  visto_em      TEXT,
  ip            TEXT,
  agente        TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessoes_conta ON sessoes (conta_id);
CREATE INDEX IF NOT EXISTS idx_sessoes_expira ON sessoes (expira_em);

-- Códigos de 6 dígitos. Guardados como hash, uso único, com expiração e
-- limite de tentativas. finalidade='trocar-email' vai para o e-mail ANTIGO
-- (regra do briefing) — o destino registrado prova para onde foi.
CREATE TABLE IF NOT EXISTS codigos (
  id            TEXT PRIMARY KEY,
  conta_id      TEXT NOT NULL REFERENCES contas (id) ON DELETE CASCADE,
  finalidade    TEXT NOT NULL CHECK (finalidade IN (
                  'verificar-email', 'recuperar-senha', 'trocar-email', 'alterar-conta'
                )),
  codigo_hash   TEXT NOT NULL,
  destino       TEXT NOT NULL,
  carga         TEXT,               -- JSON: dados pendentes de confirmação
  expira_em     TEXT NOT NULL,
  tentativas    INTEGER NOT NULL DEFAULT 0,
  usado_em      TEXT,
  criado_em     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_codigos_conta ON codigos (conta_id, finalidade);

-- Alimenta o freio de força bruta no login.
CREATE TABLE IF NOT EXISTS tentativas_login (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  chave     TEXT NOT NULL,          -- ip ou email normalizado
  sucesso   INTEGER NOT NULL,
  em        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tentativas_chave ON tentativas_login (chave, em);

-- ---------------------------------------------------------------------------
-- CAMPEONATOS
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS campeonatos (
  id                        TEXT PRIMARY KEY,
  nome                      TEXT NOT NULL,
  modalidade                TEXT NOT NULL,
  banner                    TEXT,
  vagas                     INTEGER NOT NULL DEFAULT 0,
  -- limites de elenco copiados da modalidade no momento da criação: um
  -- campeonato antigo não muda de regra quando a modalidade muda
  jogadores_min             INTEGER,
  jogadores_max             INTEGER,
  reservas                  INTEGER NOT NULL DEFAULT 1,
  staff_max                 INTEGER,
  data                      TEXT,
  data_fim                  TEXT,
  local                     TEXT,
  abertura_inscricoes       TEXT,
  encerramento_inscricoes   TEXT,
  descricao                 TEXT,
  premiacao                 TEXT,   -- JSON
  termos                    TEXT,
  regulamento               TEXT,
  status                    TEXT NOT NULL DEFAULT 'rascunho'
                              CHECK (status IN ('rascunho', 'inscricoes', 'fechado',
                                                'andamento', 'encerrado')),
  classificacao             TEXT,   -- JSON: ordem final definida na apuração
  criado_em                 TEXT NOT NULL,
  atualizado_em             TEXT,
  arquivado_em              TEXT
);

CREATE INDEX IF NOT EXISTS idx_camp_status ON campeonatos (status, arquivado_em);
CREATE INDEX IF NOT EXISTS idx_camp_modalidade ON campeonatos (modalidade);

-- ---------------------------------------------------------------------------
-- TIMES, ATLETAS E COMISSÃO
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS times (
  id            TEXT PRIMARY KEY,
  conta_id      TEXT NOT NULL REFERENCES contas (id) ON DELETE CASCADE,
  nome          TEXT NOT NULL,
  modalidade    TEXT NOT NULL,
  categoria     TEXT,               -- só futebol: Sub 16/17/18, Amador, Profissional
  escudo        TEXT,
  descricao     TEXT,
  historico     TEXT,
  criado_em     TEXT NOT NULL,
  atualizado_em TEXT,
  arquivado_em  TEXT
);

CREATE INDEX IF NOT EXISTS idx_times_conta ON times (conta_id);

-- ordem preserva a sequência em que o responsável cadastrou — o front-end
-- lista jogadores nessa ordem e o export nomeia as fotos a partir dela.
CREATE TABLE IF NOT EXISTS jogadores (
  id        TEXT PRIMARY KEY,
  time_id   TEXT NOT NULL REFERENCES times (id) ON DELETE CASCADE,
  ordem     INTEGER NOT NULL DEFAULT 0,
  nome      TEXT NOT NULL,
  apelido   TEXT,
  numero    INTEGER,                -- camisa: futebol, basquete e dance
  funcao    TEXT,                   -- só futebol
  email     TEXT,
  tel       TEXT,
  nasc      TEXT,
  insta     TEXT,
  foto      TEXT,
  steam     TEXT,                   -- só shooter
  faceit    TEXT,                   -- só shooter
  reserva   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_jogadores_time ON jogadores (time_id, ordem);

CREATE TABLE IF NOT EXISTS staff (
  id        TEXT PRIMARY KEY,
  time_id   TEXT NOT NULL REFERENCES times (id) ON DELETE CASCADE,
  ordem     INTEGER NOT NULL DEFAULT 0,
  nome      TEXT NOT NULL,
  papel     TEXT,
  email     TEXT,
  tel       TEXT,
  nasc      TEXT,
  insta     TEXT,
  foto      TEXT
);

CREATE INDEX IF NOT EXISTS idx_staff_time ON staff (time_id, ordem);

-- Documentos do atleta: o briefing cita "documento vencido" como pendência
-- comum. status='vencido' é derivado de validade, não gravado à mão.
CREATE TABLE IF NOT EXISTS documentos (
  id            TEXT PRIMARY KEY,
  jogador_id    TEXT NOT NULL REFERENCES jogadores (id) ON DELETE CASCADE,
  tipo          TEXT NOT NULL CHECK (tipo IN ('identidade', 'imagem', 'responsavel', 'aptidao')),
  arquivo       TEXT,
  validade      TEXT,
  status        TEXT NOT NULL DEFAULT 'pendente'
                  CHECK (status IN ('pendente', 'enviado', 'aprovado', 'recusado', 'vencido')),
  observacao    TEXT,
  enviado_em    TEXT,
  conferido_em  TEXT,
  conferido_por TEXT REFERENCES contas (id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_documentos_unico ON documentos (jogador_id, tipo);

-- ---------------------------------------------------------------------------
-- INSCRIÇÕES
-- ---------------------------------------------------------------------------

-- Toda inscrição nasce em 'triagem' (Lista de Inscritos). O admin move para
-- 'oficial' ou 'espera' — e cada transição dispara e-mail.
CREATE TABLE IF NOT EXISTS inscricoes (
  id              TEXT PRIMARY KEY,
  campeonato_id   TEXT NOT NULL REFERENCES campeonatos (id) ON DELETE CASCADE,
  time_id         TEXT NOT NULL REFERENCES times (id) ON DELETE CASCADE,
  protocolo       TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL DEFAULT 'triagem'
                    CHECK (status IN ('triagem', 'oficial', 'espera', 'cancelada')),
  data            TEXT NOT NULL,
  observacao      TEXT,
  criado_em       TEXT NOT NULL,
  atualizado_em   TEXT
);

-- Um time não se inscreve duas vezes no mesmo campeonato.
CREATE UNIQUE INDEX IF NOT EXISTS idx_inscricoes_unica ON inscricoes (campeonato_id, time_id);
CREATE INDEX IF NOT EXISTS idx_inscricoes_status ON inscricoes (campeonato_id, status);

-- ---------------------------------------------------------------------------
-- CHAMADOS
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS chamados (
  id            TEXT PRIMARY KEY,
  protocolo     TEXT NOT NULL UNIQUE,
  conta_id      TEXT REFERENCES contas (id) ON DELETE SET NULL,
  campeonato_id TEXT REFERENCES campeonatos (id) ON DELETE SET NULL,
  time_id       TEXT REFERENCES times (id) ON DELETE SET NULL,
  assunto       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'aberto'
                  CHECK (status IN ('aberto', 'andamento', 'respondido', 'encerrado')),
  autor         TEXT,
  aberto_em     TEXT NOT NULL,
  atualizado_em TEXT,
  arquivado_em  TEXT
);

CREATE INDEX IF NOT EXISTS idx_chamados_status ON chamados (status);
CREATE INDEX IF NOT EXISTS idx_chamados_conta ON chamados (conta_id);

CREATE TABLE IF NOT EXISTS chamado_mensagens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  chamado_id  TEXT NOT NULL REFERENCES chamados (id) ON DELETE CASCADE,
  de          TEXT NOT NULL CHECK (de IN ('usuario', 'org', 'sistema')),
  autor       TEXT,
  texto       TEXT NOT NULL,
  hora        TEXT,               -- rótulo exibido, no formato que o front-end já usa
  criado_em   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mensagens_chamado ON chamado_mensagens (chamado_id, id);

-- ---------------------------------------------------------------------------
-- RANKING E RESULTADOS
-- ---------------------------------------------------------------------------

-- Alimentado exclusivamente pela apuração dos campeonatos (regra do briefing).
CREATE TABLE IF NOT EXISTS ranking (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  modalidade  TEXT NOT NULL,
  nome        TEXT NOT NULL,
  uf          TEXT,
  v           INTEGER NOT NULL DEFAULT 0,
  e           INTEGER NOT NULL DEFAULT 0,
  d           INTEGER NOT NULL DEFAULT 0,
  camp        INTEGER NOT NULL DEFAULT 0,
  titulos     INTEGER NOT NULL DEFAULT 0,
  gotf        INTEGER NOT NULL DEFAULT 0,
  posicao     INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ranking_unico ON ranking (modalidade, nome);

CREATE TABLE IF NOT EXISTS ranking_config (
  modalidade      TEXT PRIMARY KEY,
  pontos_vitoria  INTEGER NOT NULL DEFAULT 3,
  pontos_empate   INTEGER NOT NULL DEFAULT 1,
  pontos_derrota  INTEGER NOT NULL DEFAULT 0,
  bonus_titulo    INTEGER NOT NULL DEFAULT 10,
  bonus_gotf      INTEGER NOT NULL DEFAULT 5,
  min_campeonatos INTEGER NOT NULL DEFAULT 1,
  ativo           INTEGER NOT NULL DEFAULT 1
);

-- Placar phygital: o resultado é a soma da metade digital com a física.
CREATE TABLE IF NOT EXISTS resultados (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  data          TEXT,
  mod           TEXT,
  camp          TEXT,
  local         TEXT,
  fase          TEXT,
  casa_nome     TEXT, casa_escudo INTEGER, casa_digital INTEGER, casa_fisico INTEGER,
  fora_nome     TEXT, fora_escudo INTEGER, fora_digital INTEGER, fora_fisico INTEGER
);

-- ---------------------------------------------------------------------------
-- CONTEÚDO PÚBLICO
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS categorias (
  id            TEXT PRIMARY KEY,
  nome          TEXT NOT NULL,
  descricao     TEXT,
  cor           TEXT,
  arquivado_em  TEXT
);

CREATE TABLE IF NOT EXISTS posts (
  id            TEXT PRIMARY KEY,
  titulo        TEXT NOT NULL,
  cat           TEXT,
  data          TEXT,
  autor         TEXT,
  img           TEXT,
  resumo        TEXT,
  corpo         TEXT,
  publicado     INTEGER NOT NULL DEFAULT 1,
  criado_em     TEXT NOT NULL,
  atualizado_em TEXT,
  arquivado_em  TEXT
);

CREATE INDEX IF NOT EXISTS idx_posts_data ON posts (data DESC);

CREATE TABLE IF NOT EXISTS eventos (
  id            TEXT PRIMARY KEY,
  titulo        TEXT NOT NULL,
  mod           TEXT,
  ano           INTEGER,
  local         TEXT,
  fotos         INTEGER NOT NULL DEFAULT 0,
  arquivado_em  TEXT
);

CREATE TABLE IF NOT EXISTS parceiros (
  id            TEXT PRIMARY KEY,
  nome          TEXT NOT NULL,
  tipo          TEXT,
  logo          TEXT,
  ordem         INTEGER NOT NULL DEFAULT 0,
  arquivado_em  TEXT
);

-- Banner do painel do competidor.
CREATE TABLE IF NOT EXISTS banners (
  id            TEXT PRIMARY KEY,
  titulo        TEXT,
  img           TEXT,
  link          TEXT,
  ordem         INTEGER NOT NULL DEFAULT 0,
  ativo         INTEGER NOT NULL DEFAULT 1,
  arquivado_em  TEXT
);

-- Banner do hero do site público — aceita imagem ou vídeo.
CREATE TABLE IF NOT EXISTS banners_site (
  id              TEXT PRIMARY KEY,
  titulo          TEXT,
  texto           TEXT,
  eyebrow         TEXT,
  botao           TEXT, link  TEXT,
  botao2          TEXT, link2 TEXT,
  midia           TEXT NOT NULL DEFAULT 'imagem' CHECK (midia IN ('imagem', 'video')),
  img             TEXT,
  video           TEXT,
  titulo_tamanho  INTEGER NOT NULL DEFAULT 0,
  sem_texto       INTEGER NOT NULL DEFAULT 0,
  ordem           INTEGER NOT NULL DEFAULT 0,
  ativo           INTEGER NOT NULL DEFAULT 1,
  arquivado_em    TEXT
);

-- ---------------------------------------------------------------------------
-- TRADUÇÃO DO CONTEÚDO CADASTRADO
-- ---------------------------------------------------------------------------

-- O português é a língua de origem e continua na coluna normal de cada tabela.
-- Inglês e espanhol vivem aqui, numa tabela genérica: uma coluna por idioma em
-- cada tabela seriam dezenas de colunas e uma migração a cada idioma novo.
--
-- Sem chave estrangeira de propósito: `tabela` aponta para sete tabelas
-- diferentes e o SQLite não tem referência polimórfica. Quem exclui um registro
-- em definitivo chama traducoes.apagarRegistro().
--
-- A lista de campos traduzíveis por tabela NÃO está aqui: está em
-- server/traducoes.js (CAMPOS_TRADUZIVEIS), a constante única que a API e a
-- tela do administrador leem.
CREATE TABLE IF NOT EXISTS traducoes (
  tabela        TEXT NOT NULL,
  registro_id   TEXT NOT NULL,
  campo         TEXT NOT NULL,
  idioma        TEXT NOT NULL CHECK (idioma IN ('pt', 'en', 'es')),
  texto         TEXT,
  atualizado_em TEXT NOT NULL,
  PRIMARY KEY (tabela, registro_id, campo, idioma)
);

-- A leitura sempre pergunta por (tabela, idioma) e uma lista de registros.
CREATE INDEX IF NOT EXISTS idx_traducoes_leitura
  ON traducoes (tabela, idioma, registro_id);

-- ---------------------------------------------------------------------------
-- E-MAIL
-- ---------------------------------------------------------------------------

-- Configuração única de SMTP (o briefing proíbe um segundo caminho de e-mail).
-- A senha NÃO fica aqui: vem de PHYGITAL_SMTP_SENHA no ambiente.
CREATE TABLE IF NOT EXISTS smtp (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  email             TEXT,
  usuario           TEXT,
  servidor_entrada  TEXT,
  imap              INTEGER,
  pop3              INTEGER,
  servidor_saida    TEXT,
  smtp              INTEGER,
  seguranca         TEXT,
  remetente         TEXT,
  atualizado_em     TEXT
);

CREATE TABLE IF NOT EXISTS modelos_email (
  id            TEXT PRIMARY KEY,
  grupo         TEXT,
  nome          TEXT NOT NULL,
  quando        TEXT,
  para          TEXT CHECK (para IN ('competidor', 'admin')),
  assunto       TEXT NOT NULL,
  corpo         TEXT NOT NULL,
  ativo         INTEGER NOT NULL DEFAULT 1,
  atualizado_em TEXT
);

-- Fila/histórico de envio. Sem senha de SMTP no ambiente nada sai de verdade:
-- o envio fica registrado com status='simulado' para poder ser inspecionado
-- nos testes. Com senha, a linha nasce 'fila' e quem transmite é o despachante
-- de server/fila-email.js, que roda fora das transações de negócio.
--
-- tentativas/proxima_tentativa/enviado_em são o estado do despachante: quantas
-- vezes esta linha já foi ao servidor, quando pode voltar a ser tentada depois
-- de uma falha temporária, e quando o servidor confirmou a entrega.
CREATE TABLE IF NOT EXISTS emails_enviados (
  id                TEXT PRIMARY KEY,
  modelo_id         TEXT REFERENCES modelos_email (id) ON DELETE SET NULL,
  assunto           TEXT NOT NULL,
  destino           TEXT,
  para              TEXT,
  corpo             TEXT,
  qtd               INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'simulado'
                      CHECK (status IN ('simulado', 'entregue', 'falhou', 'fila')),
  erro              TEXT,
  data              TEXT NOT NULL,
  tentativas        INTEGER NOT NULL DEFAULT 0,
  proxima_tentativa TEXT,
  enviado_em        TEXT,
  -- Metadados dos anexos do disparo, em JSON: [{nome, caminho, tipo, tamanho}].
  -- O binário fica em site/assets/enviados/; o dispatcher (server/fila-email.js)
  -- carrega o arquivo do disco na hora de montar o multipart do SMTP.
  anexos            TEXT
);

CREATE INDEX IF NOT EXISTS idx_emails_data ON emails_enviados (data DESC);

-- O índice da fila (status, proxima_tentativa) é criado em server/db.js, na
-- migração leve: num banco criado antes destas colunas, este arquivo roda ANTES
-- do ALTER TABLE e um índice sobre coluna inexistente derrubaria a subida.

-- ---------------------------------------------------------------------------
-- AUDITORIA
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS auditoria (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  area      TEXT NOT NULL,
  alvo      TEXT,
  acao      TEXT NOT NULL,
  detalhe   TEXT,
  conta_id  TEXT REFERENCES contas (id) ON DELETE SET NULL,
  autor     TEXT,
  ip        TEXT,
  em        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auditoria_em ON auditoria (em DESC);
CREATE INDEX IF NOT EXISTS idx_auditoria_area ON auditoria (area, em DESC);
