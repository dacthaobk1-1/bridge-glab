#!/bin/bash
# Setup Cloudflare Tunnel for flow_forward proxy
# Prerequisites: cloudflared installed and authenticated

# 1. Login to Cloudflare (run once)
# cloudflared tunnel login

# 2. Create tunnel
cloudflared tunnel create flow-forward

# 3. Get tunnel ID
TUNNEL_ID=$(cloudflared tunnel list | grep flow-forward | awk '{print $1}')
echo "Tunnel ID: $TUNNEL_ID"

# 4. Create config file
cat > config.yml << EOF
tunnel: $TUNNEL_ID
credentials-file: $HOME/.cloudflared/$TUNNEL_ID.json

ingress:
  - hostname: YOUR_SUBDOMAIN.YOUR_DOMAIN.COM
    service: http://localhost:3456
  - service: http_status:404
EOF

echo ""
echo "Config created! Next steps:"
echo "1. Edit config.yml - replace YOUR_SUBDOMAIN.YOUR_DOMAIN.COM with your actual domain"
echo "2. Add DNS route:  cloudflared tunnel route dns flow-forward YOUR_SUBDOMAIN.YOUR_DOMAIN.COM"
echo "3. Start proxy:    node flow_foward.js"
echo "4. Start tunnel:   cloudflared tunnel --config config.yml run flow-forward"
