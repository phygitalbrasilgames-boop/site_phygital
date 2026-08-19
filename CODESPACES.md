# Abrir no Codespaces

Como testar o site com back-end de verdade, direto do GitHub, sem instalar
nada na sua máquina. É o caminho para provar disparo de e-mail, cadastro que
persiste, upload real e tudo mais que o GitHub Pages não consegue.

---

## 1. Uma vez só: cadastrar a senha do SMTP como secret

O envio real de e-mail precisa da senha da caixa `inscricoes@phygitalgamesbr.com.br`.
Ela **não** vai no repositório — vira um Codespaces Secret, que fica visível
só para o Codespace, nunca em código.

1. Abra: **<https://github.com/settings/codespaces>**
2. Role até **Codespaces secrets** e clique em **New secret**
3. Preencha:
   - **Name:** `PHYGITAL_SMTP_SENHA`
   - **Value:** `Phygital@2026`
   - **Repository access:** selecione `phygitalbrasilgames-boop/site_phygital`
4. **Add secret**

Sem esse passo o Codespace ainda sobe, mas em modo simulado — o e-mail não sai.

---

## 2. Abrir o Codespace

Na página do repositório:

**<https://github.com/phygitalbrasilgames-boop/site_phygital>**

Botão verde **`Code`** → aba **`Codespaces`** → **`Create codespace on limpeza-artefatos-exportacao`**.

Primeira vez leva ~2 minutos: baixa a imagem Node 24, roda a semeadura do
banco, alinha as senhas de teste. Nas próximas, retoma em segundos.

Quando abrir, o VS Code em tela cheia carrega no navegador e o servidor sobe
sozinho na porta 3000 (é o `postAttachCommand`).

---

## 3. O link público

Depois que o servidor sobe, aparece um popup no canto inferior direito:

> **Your application running on port 3000 is available.**
> **[Open in Browser]**

Clique. Vai abrir num endereço tipo

```
https://<nome-do-seu-codespace>-3000.app.github.dev
```

Esse é o **link para testar tudo** — incluindo mandar para outra pessoa
(o `visibility: public` no devcontainer já deixa a porta aberta sem exigir
login do GitHub para o visitante).

---

## 4. Contas para entrar

As mesmas do site local:

| E-mail | Senha | Perfil |
|---|---|---|
| `inscricoes@phygitalgamesbr.com.br` | `Phygital@2026` | Admin master |
| `phygitalbrasilgames@gmail.com` | `Phygital@2026` | Competidor |

---

## 5. Testar o disparo de e-mail

1. Entre como admin master
2. **Disparo de E-mail** → aba **Disparar**
3. Público **Lista manual** · e-mails: `smlted@outlook.com`
4. Assunto e mensagem à vontade
5. **Enviar**

O toast verde "E-mail enviado" só aparece quando o SMTP responde 200. Confira
sua caixa (e o spam) — o link do logo no e-mail já vai apontar para o Codespace,
não para localhost.

---

## 6. Parar / retomar

- **Fechar a aba** do navegador: o Codespace continua rodando por 30 min ociosos
  e depois dorme sozinho. Reabrir na página do repositório retoma no mesmo estado.
- **Encerrar de vez:** <https://github.com/codespaces> → seu codespace → `...` → **Stop codespace** ou **Delete**.

O plano gratuito do GitHub cobre 60 horas/mês de Codespace 2-core — folgado
para testes de desenvolvimento. Consultar consumo em
<https://github.com/settings/billing>.

---

## Se algo não funcionar

- **Servidor não subiu:** abra o terminal do Codespaces (` Ctrl + ` `` ` `` `) e rode
  `node --env-file=.env server/index.js 3000` na mão. Sem `.env` no Codespace, é só
  `node server/index.js 3000` — as variáveis vêm do devcontainer + do secret.
- **E-mail sai como "simulado" no histórico:** confira se o secret foi salvo e
  tem acesso ao repositório. Depois **Command Palette** → `Codespaces: Rebuild Container`.
- **Login falha:** rode `node scripts/setup-codespaces.cjs` no terminal para
  alinhar as senhas de novo.
