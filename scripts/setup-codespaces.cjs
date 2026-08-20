#!/usr/bin/env node
/* ==========================================================================
   PHYGITAL BRASIL — SETUP DO CODESPACES

   Roda uma vez, no `postCreateCommand` do devcontainer, para deixar o ambiente
   pronto sem passo manual:

     · semeia o banco (mesmo `npm run recriar`);
     · alinha as senhas de teste com o que o front-end publicado espera
       ('Phygital@2026' para as duas contas), contornando a política do
       cadastro por painel — que recusa esta string por conter "phygital";
     · avisa se PHYGITAL_SMTP_SENHA não foi cadastrada como Codespaces Secret
       (sem ela o SMTP entra em modo simulado, não sai e-mail de verdade).

   A senha de teste é a MESMA que aparece no dados.js público do modo
   demonstração — decisão explícita do dono do projeto. Não é senha de conta
   pessoal.
   ========================================================================== */
'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');

console.log('\n[setup-codespaces] 1/2  semeando o banco…\n');
/* `--recriar` sem `--demo`: o banco nasce com o MÍNIMO — apenas as duas
   contas de acesso (u1 + comp1), o SMTP, os modelos de e-mail e a config
   de ranking. Times, campeonatos, chamados, posts, banners e histórico de
   e-mails são cadastrados pelo próprio dono no painel, como aconteceria em
   qualquer instalação nova. Para reencher a demonstração inteira: acrescente
   `--demo` (ver docs de server/semente.js). */
execFileSync('node', ['server/semente.js', '--recriar'], {
  cwd: RAIZ, stdio: 'inherit',
  env: {
    ...process.env,
    /* Senha sorteada de propósito — vamos sobrescrever logo abaixo com a que o
       front-end publicado usa. Deixar em branco faria a política sortear e
       imprimir; assinalando um valor que a política aceita, evitamos o ruído. */
    PHYGITAL_ADMIN_SENHA: 'Codespace' + Math.floor(Math.random() * 1e6) + 'Setup',
    PHYGITAL_COMPETIDOR_SENHA: 'Codespace' + Math.floor(Math.random() * 1e6) + 'Setup'
  }
});

console.log('\n[setup-codespaces] 2/2  alinhando as senhas de teste…');

const db = require(path.join(RAIZ, 'server', 'db'));
const auth = require(path.join(RAIZ, 'server', 'auth'));

db.abrir();

const SENHA_TESTE = 'Phygital@2026';
const CONTAS = [
  'inscricoes@phygitalgamesbr.com.br',
  'phygitalbrasilgames@gmail.com'
];

for (const email of CONTAS) {
  const cred = auth.criarSenha(SENHA_TESTE);
  const r = db.executar(
    'UPDATE contas SET senha_hash = ?, senha_salt = ?, senha_provisoria = 0 WHERE email = ?',
    cred.senha_hash, cred.senha_salt, email
  );
  console.log('   ' + email + '  ' + (r.changes ? 'alinhada' : 'NAO ENCONTRADA'));
}

db.fechar();

console.log('\n[setup-codespaces] pronto.');
console.log('   Contas de teste : as duas com senha Phygital@2026');
console.log('   Banco vazio     : sem times, campeonatos ou chamados — cadastre pelo painel.');

if (!process.env.PHYGITAL_SMTP_SENHA) {
  console.log('\n   ATENÇÃO: PHYGITAL_SMTP_SENHA não está definida.');
  console.log('   O servidor sobe em modo SIMULADO — nada de e-mail real sai.');
  console.log('   Para ligar o SMTP:');
  console.log('     1. Abra https://github.com/settings/codespaces');
  console.log('     2. Em "Repository access secrets", cadastre:');
  console.log('          PHYGITAL_SMTP_SENHA  = <senha da conta inscricoes@>');
  console.log('     3. Marque o repositório phygitalbrasilgames-boop/site_phygital');
  console.log('     4. Rebuilde o Codespace (Command Palette > "Rebuild Container")');
} else {
  console.log('   PHYGITAL_SMTP_SENHA está no ambiente — envio real ligado.');
}
