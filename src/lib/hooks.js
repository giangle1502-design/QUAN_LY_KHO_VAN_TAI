import { useEffect, useState } from 'react';
import { collection, onSnapshot } from 'firebase/firestore';
import { db } from '../firebase';

// Nghe realtime toàn bộ 1 collection danh mục (danh mục thường nhỏ, vài nghìn dòng)
export function useCollection(name) {
  const [state, setState] = useState({ rows: [], loading: true, error: '' });
  useEffect(() => {
    if (!name) return;
    setState((s) => ({ ...s, loading: true }));
    return onSnapshot(
      collection(db, name),
      (snap) => setState({ rows: snap.docs.map((d) => ({ _id: d.id, ...d.data() })), loading: false, error: '' }),
      (e) => setState({ rows: [], loading: false, error: e.message })
    );
  }, [name]);
  return state;
}
