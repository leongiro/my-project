export default function handler(req, res) {
  const { name } = req.query;

  res.status(200).json({
    ok: true,
    message: `Hallo${name ? ", " + name : ""}! De API werkt.`,
    timestamp: new Date().toISOString(),
    method: req.method,
  });
}
