// 📁 utils/getUsuarioLogado.js
export default function getUsuarioLogado(req) {
  const u = req.usuario;
  if (!u?.id || !u?.tipo) return { id: null, tipo: null, nome: null };
  return { id: u.id, tipo: u.tipo, nome: u.nome ?? null };
}
