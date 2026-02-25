
import baileys from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import ipp from 'ipp';
import qrcode from 'qrcode-terminal';

const {
    default: makeWASocket,
    useMultiFileAuthState,
    downloadMediaMessage,
    DisconnectReason
} = baileys;

// --- CONFIGURAÇÃO ---
// !!! IMPORTANTE !!!
// Encontre o endereço IP da sua impressora na sua rede e coloque-o aqui.
// Exemplo: "192.168.1.100"
// Você pode encontrar isso no painel da impressora, em Configurações > Rede.
const PRINTER_IP = "SEU_IP_DA_IMPRESSORA_AQUI"; // <-- COLOQUE O IP AQUI
const PRINTER_URI = `ipp://${PRINTER_IP}/ipp/print`;
const UPLOADS_DIR = 'impressoes_recebidas';

// Gerenciador de estado da conversa (armazena o progresso de cada usuário)
const conversationState = new Map();

/**
 * Envia um arquivo para a impressora usando o protocolo IPP (Internet Printing Protocol).
 * @param {string} filePath - O caminho para o arquivo a ser impresso.
 * @param {object} options - Opções de impressão.
 * @param {number} options.copies - Número de cópias.
 * @param {'mono' | 'color'} options.colorMode - Modo de cor ('mono' ou 'color').
 * @returns {Promise<boolean>} - Retorna true se a impressão foi enviada com sucesso, false caso contrário.
 */
async function printDocument(filePath, options) {
    if (PRINTER_IP === "SEU_IP_DA_IMPRESSORA_AQUI") {
        console.error("ERRO DE CONFIGURAÇÃO: O IP da impressora não foi definido no arquivo app.js.");
        return false;
    }

    if (!fs.existsSync(filePath)) {
        console.error('Erro: Arquivo não encontrado para impressão:', filePath);
        return false;
    }

    try {
        const fileBuffer = fs.readFileSync(filePath);
        const printer = ipp.Printer(PRINTER_URI);

        const msg = {
            "operation-attributes-tag": {
                "requesting-user-name": "WhatsAppBot",
                "job-name": path.basename(filePath),
                "document-format": "application/octet-stream"
            },
            "job-attributes-tag": {
                "copies": options.copies || 1,
                "print-color-mode": options.colorMode === 'color' ? 'color' : 'monochrome'
            },
            data: fileBuffer
        };

        console.log(`Enviando para a impressora em ${PRINTER_URI}:`, { filePath, copies: options.copies, colorMode: options.colorMode });

        const response = await new Promise((resolve, reject) => {
            printer.execute("Print-Job", msg, (err, res) => {
                if (err) return reject(err);
                resolve(res);
            });
        });

        if (response.statusCode === 'successful-ok') {
            console.log(`Trabalho de impressão enviado com sucesso. Job ID: ${response['job-attributes-tag']['job-id']}`);
            return true;
        } else {
            console.error('A impressora retornou um erro:', response);
            return false;
        }

    } catch (error) {
        console.error('Ocorreu um erro ao enviar o documento para a impressora via IPP:', error);
        return false;
    }
}


/**
 * Função principal para iniciar o bot e configurar os listeners.
 */
async function startBot() {
    // Garante que o diretório de uploads existe
    if (!fs.existsSync(UPLOADS_DIR)) {
        fs.mkdirSync(UPLOADS_DIR);
    }

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    // Cria a conexão com o WhatsApp
    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
    });

    // Listener para o estado da conexão
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('QR Code recebido, escaneie abaixo com seu celular:');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Conexão fechada devido a', lastDisconnect.error, ', reconectando:', shouldReconnect);
            if (shouldReconnect) {
                startBot();
            }
        } else if (connection === 'open') {
            console.log('Conexão aberta! O bot está online.');
        }
    });

    // Salva as credenciais sempre que forem atualizadas
    sock.ev.on('creds.update', saveCreds);

    // Listener para novas mensagens
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) {
            return;
        }

        const jid = m.key.remoteJid;
        const userState = conversationState.get(jid) || { status: 'awaiting_welcome' };

        try {
            const messageType = Object.keys(m.message)[0];
            const messageContent = m.message[messageType];
            const textContent = (m.message.conversation || m.message.extendedTextMessage?.text || '').toLowerCase().trim();

            if (userState.status === 'awaiting_welcome' || ['oi', 'olá', 'iniciar'].includes(textContent)) {
                await sock.sendMessage(jid, { text: 'Olá! Bem-vindo(a) ao nosso serviço de impressão automática. Por favor, envie o documento que você deseja imprimir (PDF, DOCX, JPG, PNG).' });
                conversationState.set(jid, { status: 'awaiting_file' });
                return;
            }

            if (userState.status === 'awaiting_file') {
                const supportedMessages = ['documentMessage', 'imageMessage'];
                if (supportedMessages.includes(messageType)) {
                    const buffer = await downloadMediaMessage(m, 'buffer', {}, { logger: pino().child({ level: 'silent' }) });
                    const fileName = messageContent.fileName || `${m.key.id}.${messageContent.mimetype.split('/')[1]}`;
                    const filePath = path.join(UPLOADS_DIR, fileName);

                    fs.writeFileSync(filePath, buffer);

                    userState.filePath = filePath;
                    userState.fileName = fileName;
                    userState.status = 'awaiting_color_choice';
                    conversationState.set(jid, userState);
                    
                    const menuText = `Arquivo "${fileName}" recebido!\n\nComo será a impressão?\nDigite o número da opção desejada:\n1. Preto e Branco\n2. Colorida`;
                    await sock.sendMessage(jid, { text: menuText });

                } else {
                     await sock.sendMessage(jid, { text: 'Por favor, envie um arquivo válido (PDF, DOCX, JPG ou PNG).' });
                }
                return;
            }

            if (userState.status === 'awaiting_color_choice') {
                 if (messageType !== 'conversation' && messageType !== 'extendedTextMessage') {
                     await sock.sendMessage(jid, { text: 'Opção inválida. Por favor, responda com o número da opção desejada.' });
                     return;
                 }

                 const choice = textContent.trim();
                 if (choice === '1') {
                     userState.colorMode = 'mono';
                 } else if (choice === '2') {
                     userState.colorMode = 'color';
                 } else {
                     await sock.sendMessage(jid, { text: 'Opção inválida. Por favor, digite 1 para Preto e Branco ou 2 para Colorida.' });
                     return;
                 }
                 
                 userState.status = 'awaiting_copies_number';
                 conversationState.set(jid, userState);
                 
                 const colorSelectionText = userState.colorMode === 'color' ? 'Colorida' : 'Preto e Branco';
                 
                 const copiesPrompt = `Ok, impressão ${colorSelectionText}.\n\nE quantas cópias você deseja?`;
                 await sock.sendMessage(jid, { text: copiesPrompt });
                 return;
            }

            if (userState.status === 'awaiting_copies_number') {
                if (messageType !== 'conversation' && messageType !== 'extendedTextMessage') {
                    await sock.sendMessage(jid, { text: 'Por favor, digite um número válido para a quantidade de cópias.' });
                    return;
                }

                const copies = parseInt(textContent, 10);
                
                if (isNaN(copies) || copies <= 0) {
                    await sock.sendMessage(jid, { text: 'Por favor, digite um número válido e positivo.' });
                    return;
                }

                userState.copies = copies;
                const colorText = userState.colorMode === 'color' ? 'colorido' : 'preto e branco';

                await sock.sendMessage(jid, { text: `Ok, imprimindo ${copies} cópia(s) de "${userState.fileName}" em modo ${colorText}. Aguarde...` });

                const success = await printDocument(userState.filePath, {
                    copies: userState.copies,
                    colorMode: userState.colorMode
                });

                if (success) {
                    await sock.sendMessage(jid, { text: 'Pronto! Seu documento foi enviado para a impressora. Você pode retirá-lo no balcão.' });
                } else {
                    await sock.sendMessage(jid, { text: 'Ocorreu um erro ao enviar seu documento para a impressora. Verifique se o bot está configurado corretamente ou fale com um de nossos atendentes.' });
                }

                if(userState.filePath && fs.existsSync(userState.filePath)) {
                    fs.unlinkSync(userState.filePath);
                }
                conversationState.delete(jid);
                return;
            }

        } catch (error) {
            console.error('Erro ao processar mensagem:', error);
            const userStateOnError = conversationState.get(jid);
            if(userStateOnError && userStateOnError.filePath && fs.existsSync(userStateOnError.filePath)) {
                fs.unlinkSync(userStateOnError.filePath);
            }
            conversationState.delete(jid);
            await sock.sendMessage(jid, { text: 'Ocorreu um erro inesperado. Por favor, digite "olá" para recomeçar.' });
        }
    });
}

// Inicia o bot
startBot();

/*
### COMO CONFIGURAR E EXECUTAR ESTE BOT (VERSÃO ATUALIZADA) ###

1.  **Instale o Node.js:** Baixe e instale a versão LTS do Node.js em: https://nodejs.org/

2.  **Crie uma Pasta para o Projeto:**
    mkdir bot-impressao
    cd bot-impressao

3.  **Inicie o Projeto Node.js:**
    npm init -y

4.  **Instale as Dependências:**
    npm install @whiskeysockets/baileys ipp pino qrcode-terminal

5.  **Salve este código** como `app.js` dentro da pasta do projeto.

6.  **CONFIGURE O IP DA IMPRESSORA:**
    -   Encontre o endereço IP da sua impressora. Geralmente, você pode encontrá-lo no visor da impressora, em "Configurações de Rede" ou "Status da Rede".
    -   No início do arquivo `app.js`, altere o valor da variável `PRINTER_IP` para o endereço IP que você encontrou.
    -   Exemplo: const PRINTER_IP = "192.168.1.55";

7.  **Execute o Bot:**
    node app.js

8.  **Escaneie o QR Code:**
    -   Um QR Code aparecerá no seu terminal.
    -   Abra o WhatsApp no seu celular, vá em "Aparelhos conectados" e escaneie o código.

9.  **Pronto!** O bot estará online e pronto para imprimir via rede.
*/
