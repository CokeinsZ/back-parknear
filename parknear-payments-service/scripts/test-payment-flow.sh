#!/bin/bash

# Configuration
# Debes usar una Public Key de Prueba (TEST-xxxx) asociada al mismo entorno que tu ACCESS_TOKEN
TEST_PUBLIC_KEY="TEST-b220c336-f392-400d-b09c-a936c049b974" 
BACKEND_URL="https://payments.parknear.online"

echo "--- Iniciando prueba de flujo de pago ---"

# 1. Obtener Token de Tarjeta
echo "1. Generando token de tarjeta..."
# Nota: Para pruebas, el nombre del tarjetahabiente (APRO) y el email son cruciales.
TOKEN_RESPONSE=$(curl -s -X POST "https://api.mercadopago.com/v1/card_tokens?public_key=${TEST_PUBLIC_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "card_number": "5254133674403564",
    "security_code": "123",
    "expiration_month": 11,
    "expiration_year": 2030,
    "cardholder": {
      "name": "APRO",
      "identification": {
        "type": "CC",
        "number": "123456789"
      }
    }
  }')

CARD_TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r '.id')

if [ "$CARD_TOKEN" == "null" ] || [ -z "$CARD_TOKEN" ]; then
    echo "Error: No se pudo generar el token. Verifica la TEST_PUBLIC_KEY."
    echo "Respuesta de MP: $TOKEN_RESPONSE"
    exit 1
fi

echo "   Token generado: $CARD_TOKEN"

# 2. Crear Pago en el Backend
echo "2. Creando pago en backend..."
# Asegúrate de que este email NO sea el mismo que el dueño de la cuenta de Mercado Pago
PAYO_RESPONSE=$(curl -s -X POST "${BACKEND_URL}/pagos" \
  -H "Content-Type: application/json" \
  -d "{
    \"idReserva\": 124,
    \"monto\": 6514.00,
    \"datosPago\": {
      \"transaction_amount\": 6514.00,
      \"token\": \"$CARD_TOKEN\",
      \"installments\": 1,
      \"payment_method_id\": \"master\",
      \"payer\": {
        \"email\": \"stivencarvajal205@gmail.com\"
      }
    }
  }")

echo "   Resultado del pago:"
echo "$PAYO_RESPONSE" | jq
