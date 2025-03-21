import express from 'express';
import nodemailer from 'nodemailer';
import cors from 'cors';
import { initializeApp } from 'firebase-admin/app'; // Puedes usar esto si sigues con import, pero...
import admin from 'firebase-admin';  // Aquí necesitas `require` para Firebase
import { MercadoPagoConfig, Preference, Payment, PreApproval } from 'mercadopago';
import * as dotenv from 'dotenv';
import { readFileSync } from 'fs';
// import googleCredentials from './utils/barcolombian-fdb31-cd3c85bf61bc.json' assert { type: 'json' };  
import axios from 'axios';
// Cargar variables de entorno
dotenv.config();

// admin.initializeApp({
//   credential: admin.credential.cert(googleCredentials)
// });

const serviceAccount = JSON.parse(readFileSync('/etc/secrets/barcolombian-fdb31-cd3c85bf61bc.json', 'utf-8'));  
// Inicializar Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});


const firestore = admin.firestore();

const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN_SUBSCRIPTION;
const clientSUB = new MercadoPagoConfig({ accessToken });
const preapproval = new PreApproval(clientSUB);

// SDK de Mercado Pago
const client = new MercadoPagoConfig({ 
  accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN
});

const payment = new Payment(client);


const app = express();
const corsOptions = {
  origin: '*', // Cambia esto por el dominio permitido o usa '*' para todos.
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true // Permite incluir cookies si es necesario
};

app.options('*', cors(corsOptions));  // Permitir CORS en las solicitudes preflight
app.use(cors(corsOptions)); // Habilita CORS con opciones
app.use(express.json());


// MERCADO PAGO

// Ruta para crear una preferencia de pago para una consulta
app.post('/create_preference', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  const { email, dni, price, nombre, telefono } = req.body;

  if (!price || !dni) {
    return res.status(400).json({ error: 'Faltan datos en la solicitud.' });
  }

  try {
    // Generar un ID único para la consulta
    const consultaId = createIdDoc();

    // Crear el documento en Firestore con estado "pending"
    const consultaRef = firestore.collection('consultas').doc(consultaId);
    await consultaRef.set({
      id: consultaId,
      email,
      nombre,
      telefono,
      price,
      dni,
      status: 'pending',
      createdAt: new Date().toString(),
    });

    // Crear la preferencia de pago en MercadoPago
    const preference = new Preference(client);

    const result = await preference.create({
      body: {
        items: [
          {
            id: consultaId,
            title: 'Consulta Agrofono',
            quantity: 1,
            unit_price: parseFloat(price),
          },
        ],
        back_urls: {
          success: 'https://agrofono.com',
          failure: 'https://agrofono.com',
        },
        auto_return: 'approved',
        notification_url: 'https://agroback-yp7t.onrender.com/payment_webhook',
        external_reference: consultaId, // Usamos el ID de la consulta como referencia externa
      },
    });

    return res.json({ preference: result, consultaId });
  } catch (error) {
    console.error('Error creando preferencia:', error);
    return res.status(500).json({ error: 'Error creando preferencia.' });
  }
});

// Webhook para manejar el pago de la consulta
app.post('/payment_webhook', async (req, res) => {
  try {
    const { type, data } = req.body;

    // Verifica si el cuerpo tiene el formato esperado
    if (!data || !data.id) {
      console.error("Invalid webhook payload: Missing 'data.id'");
      return res.status(400).json({ error: "Invalid webhook payload: Missing 'data.id'" });
    }

    const paymentId = data.id;

    console.log("Payment ID received from webhook: ", paymentId);
    console.log("Notification type: ", type);

    // Verifica si la notificación es del tipo "payment"
    if (type !== "payment") {
      console.warn(`Unhandled notification type: ${type}`);
      return res.status(400).json({ error: `Unhandled notification type: ${type}` });
    }

    // Verifica que las credenciales de MercadoPago estén configuradas correctamente
    if (!payment) {
      console.error("MercadoPago SDK not initialized");
      return res.status(500).json({ error: "Internal server error: MercadoPago SDK not initialized" });
    }

    let paymentInfo;
    try {
      // Realiza el get del pago usando el ID recibido
      paymentInfo = await payment.get({ id: paymentId });
      console.log("Payment Info: ", JSON.stringify(paymentInfo, null, 2));
    } catch (error) {
      console.error("Error fetching payment info: ", error);
      return res.status(500).json({ error: "Error fetching payment info" });
    }

    // Verifica que el pago esté aprobado
    if (!paymentInfo || paymentInfo.status !== "approved") {
      console.error("Payment not approved or not found");
      return res.status(400).json({ error: "Payment not approved or not found" });
    }

    const { external_reference, payer } = paymentInfo;

    if (!external_reference) {
      console.error("No external reference found in payment info");
      return res.status(400).json({ error: "No external reference found in payment info" });
    }

    console.log("External reference (consultaId): ", external_reference);

    // Consulta en la colección "consultas"
    const consultaRef = firestore.collection("consultas").doc(external_reference);
    const consultaDoc = await consultaRef.get();

    if (!consultaDoc.exists) {
      console.error(`No pending consulta found for consultaId: ${external_reference}`);
      return res.status(404).json({ error: "No pending consulta found" });
    }

    // Actualiza la consulta con el estado "completed"
    await consultaRef.update({
      status: "completed",
      paymentDate: new Date().toString(),
      payerEmail: payer?.email || null,
    });

    console.log(`Consulta successfully updated in Firestore: ${consultaRef.id}`);

    return res.status(200).json({ message: "Payment processed successfully" });
  } catch (error) {
    console.error("Error handling payment webhook: ", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});


// SUBSCRIPCIONES MERCADO PAGO

// Endpoint para crear una suscripción
app.post('/create_subscription', async (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  const { email, dni, price, nombre, telefono } = req.body;

  if (!email || !dni || !price || !nombre || !telefono) {
    return res.status(400).json({
      error: 'Los campos email, dni, price, nombre y telefono son obligatorios.',
    });
  }

  try {
    // Configuración del cuerpo de la solicitud de suscripción
    const body = {
      reason: 'Suscripción estándar',
      external_reference: dni,
      auto_recurring: {
        frequency: 1,
        frequency_type: 'months',
        transaction_amount: parseFloat(price), // Verifica que es numérico
        currency_id: 'ARS',
      },
      payer_email: email, // Email del pagador
      back_url: 'https://agrofono.com',
      notification_url: 'https://agroback-yp7t.onrender.com/sub_success',
      status: 'pending',
    };

    // Crear la suscripción a través de Mercado Pago
    const response = await preapproval.create({ body });

    // Generar un ID único para la suscripción en Firestore
    const subId = firestore.collection('subscriptions').doc().id;

    // Datos de la suscripción a guardar
    const subData = {
      email: email, // Correo del suscriptor
      subscriptionId: response.id, // ID de la suscripción creada en Mercado Pago
      subId, // ID generado en Firestore
      createdAt: new Date().toISOString(), // Fecha de creación
      dni: dni,
      price: price,
      telefono: telefono,
      nombre: nombre
    };

    // Guardar los datos de la suscripción en Firestore
    const subscriptionRef = firestore.collection('subscriptions').doc(subId);
    await subscriptionRef.set(subData);

    // Responder con el init_point inmediatamente
    res.status(200).json({
      message: 'La suscripción fue creada exitosamente.',
      init_point: response.init_point,
    });

    // Iniciar el proceso de polling en segundo plano
    pollSubscriptionStatus(response.id).then((pollingResult) => {
      if (pollingResult) {
        console.log(`La suscripción ${response.id} fue aprobada.`);
        subscriptionRef.update({ status: 'approved' });
      } else {
        console.warn(`La suscripción ${response.id} no se aprobó dentro del tiempo esperado.`);
        subscriptionRef.update({ status: 'pending' });
      }
    });
  } catch (error) {
    console.error('Error al crear la suscripción:', error.response?.data || error.message);
    return res.status(500).json({
      error: 'Ocurrió un error al intentar crear la suscripción.',
    });
  }
});


async function checkSubscriptionStatus(subscriptionId) {
  try {
    const url = `https://api.mercadopago.com/preapproval/${subscriptionId}`; // URL directa
    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${process.env.MERCADOPAGO_ACCESS_TOKEN_SUBSCRIPTION}`,
      },
    });

    if (response.data && response.data.status) {
      console.log(`Estado actual de la suscripción ${subscriptionId}: ${response.data.status}`);
      return response.data.status;
    } else {
      console.error("No se encontró la suscripción con el ID proporcionado.");
      return null;
    }
  } catch (error) {
    console.error("Error al verificar el estado de la suscripción:", error.message);
    return null;
  }
}

// Endpoint para iniciar el proceso de polling
app.post('/start_subscription_check', async (req, res) => {
  const { subscriptionId } = req.body;

  if (!subscriptionId) {
    return res.status(400).json({ error: 'El campo subscriptionId es obligatorio.' });
  }

  try {
    const result = await pollSubscriptionStatus(subscriptionId);

    if (result) {
      return res.status(200).json({ message: 'La suscripción fue aprobada.' });
    } else {
      return res.status(408).json({ error: 'La suscripción no cambió de estado dentro del tiempo límite.' });
    }
  } catch (error) {
    console.error('Error al iniciar el proceso de polling:', error.message);
    return res.status(500).json({ error: 'Error interno del servidor.' });
  }
});

// Función de polling para verificar el estado de la suscripción
async function pollSubscriptionStatus(subscriptionId, maxRetries = 10, interval = 20000) {
  let retries = 0;

  while (retries < maxRetries) {
    const status = await checkSubscriptionStatus(subscriptionId);

    if (status === "authorized") {
      console.log(`La suscripción ${subscriptionId} fue aprobada.`);
      await handleSubscriptionSuccess(subscriptionId);
      return true; // Finaliza el polling
    } else if (status) {
      console.log(`Estado actual de la suscripción ${subscriptionId}: ${status}`);
    } else {
      console.log(`No se pudo obtener el estado de la suscripción ${subscriptionId}. Reintentando...`);
    }

    // Espera antes del próximo intento
    await new Promise((resolve) => setTimeout(resolve, interval));
    retries++;
  }

  console.warn(`Tiempo de espera agotado para la suscripción ${subscriptionId}.`);
  return false; // Finaliza sin éxito
}


// Crear un transportador con la configuración de Gmail
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER, // Tu dirección de correo electrónico
    pass: process.env.EMAIL_PASS, // Tu contraseña o aplicación de contraseña de Gmail
  },
});

// Función para enviar el correo
async function sendEmail(to, subject, text) {
  const mailOptions = {
    from: process.env.EMAIL_USER,
    to,
    subject,
    text,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Correo enviado a ${to}`);
  } catch (error) {
    console.error('Error al enviar correo:', error);
  }
}



// Función para manejar la suscripción aprobada
async function handleSubscriptionSuccess(subscriptionId) {
  try {
    // Obtener detalles actualizados de la suscripción desde MercadoPago
    const url = `https://api.mercadopago.com/preapproval/${subscriptionId}`;
    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${process.env.MERCADOPAGO_ACCESS_TOKEN_SUBSCRIPTION}`,
      },
    });

    if (!response.data) {
      console.error("No se encontraron detalles de la suscripción.");
      return;
    }

    const { external_reference, status } = response.data;

    if (status !== "authorized") {
      console.warn(`La suscripción ${subscriptionId} aún no está autorizada.`);
      return;
    }

    console.log(`Procesando suscripción aprobada: ${subscriptionId}`);

    // Buscar la suscripción en Firestore
    const subscriptionRef = firestore
      .collection("subscriptions")
      .where("subscriptionId", "==", subscriptionId);

    const snapshot = await subscriptionRef.get();

    if (snapshot.empty) {
      console.error(`No se encontró la suscripción ${subscriptionId} en Firestore.`);
      return;
    }

    // Obtener los datos de la suscripción
    const doc = snapshot.docs[0];
    const subData = doc.data(); // Accedemos a los datos correctamente

    // Actualizar el estado en Firestore
    await doc.ref.update({ status: "approved" });

    // Crear el usuario en la base de datos (si no existe)
    const newUserId = createIdDoc(); // Generamos un nuevo ID único
    const usersRef = firestore.collection("usuarios").doc(newUserId);
    const userDoc = await usersRef.get();

    if (!userDoc.exists) {
      console.log(`Creando usuario con ID: ${newUserId}`);

      await usersRef.set({
        dni: subData.dni, 
        nombre: subData.nombre,
        subscriptionId: subscriptionId,
        active: false,
        id: newUserId,
        telefono: subData.telefono
      });
      sendEmail('agrofonoempresa@gmail.com', 'Nuevo Usuario Creado', `Se ha creado un nuevo usuario con DNI: ${subData.dni}.`);


      console.log(`Usuario ${newUserId} creado con éxito.`);
    } else {
      console.log(`El usuario con ID ${newUserId} ya existe.`);
    }
  } catch (error) {
    console.error("Error al procesar la suscripción aprobada:", error.message);
  }
}

// Webhook para procesar pagos exitosos de suscripciones
app.post("/sub_success", async (req, res) => {
  console.log("Webhook recibido: ", req.body);

  try {
    const { type, data } = req.body;

    if (!data || !data.id) {
      console.error("Webhook inválido: falta 'data.id'");
      return res.status(400).json({ error: "Invalid webhook payload: Missing 'data.id'" });
    }

    const subscriptionId = data.id;

    if (type !== "subscription_preapproval") {
      console.warn(`Tipo no manejado: ${type}`);
      return res.status(400).json({ error: `Unhandled type: ${type}` });
    }

    // Manejar la suscripción aprobada
    await handleSubscriptionSuccess(subscriptionId);

    res.status(200).json({ message: "Webhook procesado correctamente" });
  } catch (error) {
    console.error("Error en el webhook:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});



// Implementación de la función para generar un ID único (similar a createIdDoc)
function createIdDoc() {
  return firestore.collection('dummyCollection').doc().id; // Usamos un doc temporal para generar el ID
}

// Iniciar el servidor
app.listen(process.env.PORT || 3333, () => {
  console.log("HTTP server running on port:", process.env.PORT || 3333);
});