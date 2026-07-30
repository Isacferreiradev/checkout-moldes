require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── EvoPay Config ────────────────────────────────────────────────────
const EVOPAY_API_KEY = process.env.EVOPAY_API_KEY;
const EVOPAY_BASE_URL = 'https://pix.evopay.cash/v1';

// ─── Sigilo Pay Config ────────────────────────────────────────────────
const SIGILO_PUBLIC_KEY = process.env.SIGILO_PUBLIC_KEY;
const SIGILO_SECRET_KEY = process.env.SIGILO_SECRET_KEY;
const SIGILO_BASE_URL = 'https://app.sigilopay.com.br/api/v1';

// ─── UTMify Config ────────────────────────────────────────────────────
const UTMIFY_API_TOKEN = process.env.UTMIFY_API_TOKEN;
const UTMIFY_BASE_URL = 'https://api.utmify.com.br/api-credentials/orders';

// ─── In-memory store: transactionId → { customer, utms, amount } ──────
// Em produção, substitua por um banco de dados.
const transactionStore = {};

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ─── Roteamento de Páginas HTML ───────────────────────────────────────
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/basico', (req, res) => {
    res.sendFile(path.join(__dirname, 'basico.html'));
});

app.get('/oferta', (req, res) => {
    res.sendFile(path.join(__dirname, 'oferta.html'));
});

app.get('/checkout-mx', (req, res) => {
    res.sendFile(path.join(__dirname, 'checkout-mx.html'));
});

app.get('/gracias', (req, res) => {
    res.sendFile(path.join(__dirname, 'gracias.html'));
});

// ═══════════════════════════════════════════════════════════════════════
// ─── EvoPay Endpoints (PIX - Brasil) ──────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════

// ─── Criar Cobrança PIX ───────────────────────────────────────────────
app.post('/api/create-pix', async (req, res) => {
    try {
        const {
            amount,
            payerName,
            payerEmail,
            externalReference,
            // UTMs capturados pelo frontend
            utm_source,
            utm_campaign,
            utm_medium,
            utm_content,
            utm_term,
            src,
            sck,
            customerIp
        } = req.body;

        if (!amount || amount <= 0) {
            return res.status(400).json({ success: false, message: 'Valor inválido.' });
        }

        const payload = {
            amount: parseFloat(amount)
        };
        if (payerName && payerName.trim()) payload.payerName = payerName.trim();
        if (payerEmail && payerEmail.trim()) payload.payerEmail = payerEmail.trim();
        if (externalReference && externalReference.trim()) payload.externalReference = externalReference.trim();

        const response = await fetch(`${EVOPAY_BASE_URL}/pix`, {
            method: 'POST',
            headers: {
                'API-Key': EVOPAY_API_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        const rawText = await response.text();
        let data = {};
        try {
            data = JSON.parse(rawText);
        } catch (e) {
            console.error('EvoPay returned non-JSON response:', rawText);
        }

        if (!response.ok) {
            console.error('EvoPay error status:', response.status, data);
            return res.status(response.status || 500).json({
                success: false,
                message: data.message || data.error || rawText || 'Erro ao criar cobrança.'
            });
        }

        // Salva dados da transação para usar no webhook / polling (UTMify)
        if (data.id) {
            transactionStore[data.id] = {
                customerName: payerName || '',
                customerEmail: payerEmail || '',
                customerIp: customerIp || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '',
                amount: data.amount || parseFloat(amount),
                productName: externalReference || 'Produto',
                utms: { utm_source, utm_campaign, utm_medium, utm_content, utm_term, src, sck },
                createdAt: new Date().toISOString()
            };
            console.log(`💾 Transação armazenada: ${data.id}`);

            // Envia evento de PIX Gerado (waiting_payment) para a UTMify
            notifyUtmify(data.id, 'waiting_payment');
        }

        // Retorna apenas os dados necessários para o frontend
        res.json({
            success: true,
            transaction: {
                id: data.id,
                status: data.status,
                amount: data.amount,
                qrCodeText: data.qrCodeText,
                qrCodeBase64: data.qrCodeBase64,
                qrCodeUrl: data.qrCodeUrl
            }
        });

    } catch (error) {
        console.error('Server error:', error);
        res.status(500).json({ success: false, message: 'Erro interno do servidor.' });
    }
});

// ─── Consultar Status da Cobrança ─────────────────────────────────────
app.get('/api/pix-status', async (req, res) => {
    try {
        const { id } = req.query;

        if (!id) {
            return res.status(400).json({ success: false, message: 'ID da transação é obrigatório.' });
        }

        const response = await fetch(`${EVOPAY_BASE_URL}/pix?id=${encodeURIComponent(id)}`, {
            method: 'GET',
            headers: {
                'API-Key': EVOPAY_API_KEY
            }
        });

        const rawText = await response.text();
        let data = {};
        try {
            data = JSON.parse(rawText);
        } catch (e) {
            console.error('EvoPay returned non-JSON response on status check:', rawText);
        }

        if (!response.ok) {
            return res.status(response.status || 500).json({
                success: false,
                message: data.message || data.error || 'Erro ao consultar status.'
            });
        }

        if (data.status === 'COMPLETED') {
            console.log(`✅ Pagamento confirmado via polling! ID: ${id}`);
            notifyUtmify(id, 'paid', data);
        }

        res.json({
            success: true,
            transaction: {
                id: data.id,
                status: data.status,
                amount: data.amount
            }
        });

    } catch (error) {
        console.error('Server error:', error);
        res.status(500).json({ success: false, message: 'Erro interno do servidor.' });
    }
});

// ─── Notificar UTMify ─────────────────────────────────────────────────
async function notifyUtmify(transactionId, status = 'paid', extraData = {}) {
    try {
        const stored = transactionStore[transactionId];
        if (!stored) {
            console.warn(`⚠️  UTMify: dados não encontrados para transação ${transactionId}`);
            return;
        }

        const nowIso = new Date().toISOString();
        const priceInCents = Math.round((stored.amount || extraData.amount || 0) * 100);

        const utmifyPayload = {
            orderId: transactionId,
            platform: 'evopay',
            paymentMethod: 'pix',
            status: status, // 'waiting_payment' ou 'paid'
            createdAt: stored.createdAt || nowIso,
            approvedDate: status === 'paid' ? nowIso : null,
            customer: {
                name: stored.customerName,
                email: stored.customerEmail,
                phone: null,
                document: null,
                country: 'BR',
                ip: stored.customerIp || null
            },
            products: [
                {
                    id: transactionId,
                    name: stored.productName,
                    planId: transactionId,
                    planName: stored.productName,
                    quantity: 1,
                    priceInCents: priceInCents
                }
            ],
            commission: {
                totalPriceInCents: priceInCents,
                gatewayFeeInCents: 0,
                userCommissionInCents: priceInCents
            },
            isTest: false,
            trackingParameters: {
                src: stored.utms.src || null,
                sck: stored.utms.sck || null,
                utm_source: stored.utms.utm_source || null,
                utm_campaign: stored.utms.utm_campaign || null,
                utm_medium: stored.utms.utm_medium || null,
                utm_content: stored.utms.utm_content || null,
                utm_term: stored.utms.utm_term || null
            }
        };

        console.log(`📊 Enviando para UTMify (${status}):`, JSON.stringify(utmifyPayload, null, 2));

        const utmResponse = await fetch(UTMIFY_BASE_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-token': UTMIFY_API_TOKEN
            },
            body: JSON.stringify(utmifyPayload)
        });

        const utmText = await utmResponse.text();
        if (utmResponse.ok) {
            console.log(`✅ UTMify notificado com sucesso (${status}) para ${transactionId}`);
        } else {
            console.error(`❌ UTMify erro ${utmResponse.status}:`, utmText);
        }

        // Se a transação foi paga, limpa da memória
        if (status === 'paid') {
            delete transactionStore[transactionId];
        }

    } catch (err) {
        console.error('❌ Erro ao notificar UTMify:', err);
    }
}

// ─── Webhook da EvoPay ────────────────────────────────────────────────
app.post('/api/webhook', (req, res) => {
    const event = req.body;
    console.log('Webhook recebido:', JSON.stringify(event, null, 2));

    if (event.status === 'COMPLETED') {
        console.log(`✅ Pagamento confirmado via webhook! ID: ${event.id}, Valor: R$ ${event.amount}`);
        // Dispara notificação para UTMify de forma assíncrona
        notifyUtmify(event.id, 'paid', event);
    }

    // Retorna 200 rapidamente (conforme documentação)
    res.status(200).json({ received: true });
});

// ═══════════════════════════════════════════════════════════════════════
// ─── Sigilo Pay Endpoints (Cartão de Crédito - México) ────────────────
// ═══════════════════════════════════════════════════════════════════════

// ─── Criar Checkout Sigilo Pay ────────────────────────────────────────
app.post('/api/create-checkout', async (req, res) => {
    try {
        const {
            customerName,
            customerEmail,
            customerPhone,
            productName,
            price,        // valor em centavos (ex: 19900 = $199.00 MXN)
            externalId,
            productImage
        } = req.body;

        // Validações
        if (!customerName || !customerName.trim()) {
            return res.status(400).json({ success: false, message: 'Nombre del cliente es obligatorio.' });
        }
        if (!customerEmail || !customerEmail.trim()) {
            return res.status(400).json({ success: false, message: 'Email del cliente es obligatorio.' });
        }
        if (!price || price <= 0) {
            return res.status(400).json({ success: false, message: 'Precio inválido.' });
        }

        // Determinar a URL base para o thankYouPage
        const protocol = req.protocol;
        const host = req.get('host');
        // Usar um domínio falso para localhost para não ser bloqueado pelo WAF da Sigilo
        const thankYouPage = host.includes('localhost') ? 'https://meudominio.com/gracias.html' : `${protocol}://${host}/gracias.html`;

        const payload = {
            product: {
                name: productName || 'Producto',
                externalId: externalId || `MX-${Date.now()}`,
                photos: productImage ? [productImage] : [],
                offer: {
                    name: productName || 'Oferta',
                    price: parseInt(price),
                    offerType: 'REGULAR',
                    currency: 'BRL',
                    lang: 'pt-BR'
                }
            },
            settings: {
                paymentMethods: ['PIX'],
                acceptedDocs: [],
                thankYouPage: thankYouPage,
                askForAddress: true,
                colors: {
                    primaryColor: '#e91e63',
                    text: '#ffffff',
                    background: '#1e293b',
                    purchaseButtonBackground: '#00c853',
                    purchaseButtonText: '#ffffff',
                    widgets: '#334155',
                    inputBackground: '#475569',
                    inputText: '#ffffff'
                }
            },
            customer: {
                name: customerName.trim(),
                email: customerEmail.trim(),
                phone: customerPhone ? customerPhone.trim() : '',
                document: '00000000000',
                address: {
                    street: '',
                    number: '',
                    city: '',
                    state: '',
                    zipCode: '',
                    neighborhood: '',
                    complement: ''
                }
            },
            trackProps: {
                utm_source: 'checkout_mexico',
                utm_content: ''
            }
        };

        console.log('📤 Criando checkout Sigilo Pay:', JSON.stringify(payload, null, 2));

        const response = await fetch(`${SIGILO_BASE_URL}/gateway/checkout`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-public-key': SIGILO_PUBLIC_KEY,
                'x-secret-key': SIGILO_SECRET_KEY,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            body: JSON.stringify(payload)
        });

        const rawText = await response.text();
        let data = {};
        try {
            data = JSON.parse(rawText);
        } catch (e) {
            console.error('Sigilo Pay returned non-JSON response:', rawText);
        }

        if (!response.ok) {
            console.error('Sigilo Pay error:', response.status, data);
            return res.status(response.status || 500).json({
                success: false,
                message: data.message || data.error || rawText || 'Error al crear el checkout.'
            });
        }

        console.log('✅ Checkout Sigilo Pay criado:', JSON.stringify(data, null, 2));

        // A API retorna o link do checkout
        res.json({
            success: true,
            checkout: {
                id: data.id || data._id,
                url: data.checkoutUrl || data.url || data.link,
                raw: data  // dados completos para debug
            }
        });

    } catch (error) {
        console.error('Server error (Sigilo Pay):', error);
        res.status(500).json({ success: false, message: 'Error interno del servidor.' });
    }
});

// ─── Webhook da Sigilo Pay ────────────────────────────────────────────
app.post('/api/sigilo-webhook', (req, res) => {
    const event = req.body;
    console.log('🔔 Webhook Sigilo Pay recebido:', JSON.stringify(event, null, 2));

    // Verificar o evento de pagamento confirmado
    if (event.event === 'TRANSACTION_PAID' || event.status === 'PAID') {
        console.log(`✅ [Sigilo Pay] Pagamento confirmado!`);
        console.log(`   ID: ${event.id || event.transactionId}`);
        console.log(`   Valor: ${event.amount || event.value}`);
        console.log(`   Cliente: ${event.customer?.name || 'N/A'}`);
        console.log(`   Email: ${event.customer?.email || 'N/A'}`);
        // Aqui você pode:
        // - Salvar no banco de dados
        // - Enviar email de confirmação
        // - Liberar acesso ao produto
    }

    // Retorna 200 rapidamente
    res.status(200).json({ received: true });
});

// ─── Start Server ─────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n🚀 Servidor rodando em http://localhost:${PORT}`);
    console.log(`\n── Brasil (PIX - EvoPay) ──────────────────`);
    console.log(`📦 Checkout Completo:    http://localhost:${PORT}/index.html`);
    console.log(`📦 Checkout Básico:      http://localhost:${PORT}/basico.html`);
    console.log(`📦 Checkout Oferta:      http://localhost:${PORT}/oferta.html`);
    console.log(`\n── México (Cartão - Sigilo Pay) ───────────`);
    console.log(`📦 Checkout México:      http://localhost:${PORT}/checkout-mx.html`);
    console.log(`📦 Gracias (Thank You):  http://localhost:${PORT}/gracias.html`);
    console.log(`🔑 EvoPay API Key:    ${EVOPAY_API_KEY ? '✅' : '❌ FALTANDO!'}`);
    console.log(`🔑 Sigilo Public Key: ${SIGILO_PUBLIC_KEY ? '✅' : '❌ FALTANDO!'}`);
    console.log(`🔑 Sigilo Secret Key: ${SIGILO_SECRET_KEY ? '✅' : '❌ FALTANDO!'}`);
    console.log(`🔑 UTMify Token:     ${UTMIFY_API_TOKEN ? '✅' : '❌ FALTANDO!'}\n`);
});

module.exports = app;
