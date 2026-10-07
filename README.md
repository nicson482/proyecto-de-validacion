# Rutas e Incidencias (página web para GitHub Pages)

Página web para asignar **pilotos** y **validadores** por región (Cobán, Salamá, Petén, Poptún y Morales), reportar incidencias subidas a otra plataforma y darles seguimiento. Funciona en celular y en PC, y se puede instalar en el celular como app.

- Los datos y los accesos viven en **Firebase** (gratis en el plan Spark). GitHub solo aloja la página.
- Las incidencias se asignan solas al validador de la región con menos incidencias abiertas.
- Avisos: al validador cuando le asignan una incidencia y al piloto cuando se la aprueban o rechazan.

## Paso 1: crear el proyecto en Firebase
1. Entra a https://console.firebase.google.com y crea un proyecto (puedes desactivar Google Analytics).
2. **Authentication** > Comenzar > pestaña **Sign-in method** > activa **Correo electrónico/contraseña**.
3. **Firestore Database** > Crear base de datos > modo producción > elige una región cercana (por ejemplo `nam5` o `us-east1`).
4. En Firestore, pestaña **Reglas**: borra lo que haya, pega todo el contenido de `firestore.rules` y pulsa **Publicar**.

## Paso 2: conectar la página con tu proyecto
1. En Firebase: engranaje > **Configuración del proyecto** > **Tus apps** > icono web `</>` > registra la app (sin Hosting).
2. Copia el bloque `firebaseConfig` y pégalo en `firebase-config.js` reemplazando los valores de ejemplo.

## Paso 3: subir a GitHub
1. Crea un repositorio en GitHub (público o privado) y sube **todos** los archivos de esta carpeta a la raíz.
2. Repositorio > **Settings** > **Pages** > *Deploy from a branch* > rama `main`, carpeta `/ (root)` > Save.
3. En un minuto o dos tendrás la dirección `https://TU-USUARIO.github.io/NOMBRE-DEL-REPO/`.
4. Si al entrar Firebase marca «dominio no autorizado», agrégalo en Authentication > Configuración > Dominios autorizados: `TU-USUARIO.github.io`.

## Paso 4: primer uso
1. Abre la dirección. La primera vez te pide crear el **administrador** (nombre, usuario y PIN de al menos 6 caracteres).
2. En la pestaña **Usuarios** agrega pilotos y validadores, y asígnales una o varias regiones. Puedes editarlas cuando quieras.
3. Pasa a cada persona su usuario y PIN inicial. Cada quien puede cambiar su PIN con el botón **Cambiar PIN**.

## Instalar en el celular
- Android (Chrome): menú ⋮ > **Instalar aplicación** / **Añadir a pantalla de inicio**.
- iPhone (Safari): botón Compartir > **Añadir a pantalla de inicio**.

## Cosas que debes saber
- **Avisos:** suenan, vibran y se muestran mientras la app esté abierta (o en segundo plano en muchos celulares). Con la app completamente cerrada no llegan; eso requiere un servidor de notificaciones (Cloud Functions de Firebase, que pide plan de pago) y se puede agregar después.
- **PIN olvidado:** el administrador no puede cambiar el PIN de otra persona desde la página. Solución: crear un usuario nuevo (por ejemplo `juan2`) y desactivar el anterior.
- **Usuarios:** no se borran, se desactivan. Un usuario desactivado ya no puede entrar y sus incidencias abiertas se reasignan.
- **Privacidad:** cualquier usuario activo puede leer las incidencias (la página solo muestra a cada piloto las suyas). Las imágenes se guardan reducidas dentro de Firestore.
- La clave `apiKey` de Firebase es pública por diseño; lo que protege los datos son las reglas de `firestore.rules`.
