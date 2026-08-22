import { addPage, NamedPage } from '@hydrooj/ui-default';
import Swal from 'sweetalert2';

addPage(new NamedPage('problem_detail', async () => {
    console.log('AC-Celebration is powered by OpenBPJudge Project https://github.com/BPJudge/open-bpjudge');
    const ui = (window as any).UiContext || {};
    const user = (window as any).UserContext || {};
    let imageUrl = '/ac-congrats.png';
    if (ui.acImgUrl) imageUrl = ui.acImgUrl;
    let timer = 3500;
    if (ui.acImgDuration) timer = ui.acImgDuration;
    const showCongrats = () => Swal.fire({
        imageUrl,
        imageAlt: 'Congrats',
        imageWidth: 500,
        showConfirmButton: false,
        timer,
        background: 'transparent',
        padding: 0,
        width: 'auto',
    });
    if (!ui.ws_prefix || !ui.pretestConnUrl || typeof WebSocket !== 'function') return;
    const prevStatus = new Map();
    let sock: WebSocket;
    try {
        sock = new WebSocket(String(ui.ws_prefix) + String(ui.pretestConnUrl));
    } catch (e) {
        console.warn('[ac-celebration] skip invalid pretest websocket url', e);
        return;
    }
    sock.onmessage = (message) => {
        try {
            const msg = JSON.parse(message.data);
            const rdoc = msg.rdoc;
            if (!rdoc?._id) return;
            const rid = rdoc._id.toString();
            const prev = prevStatus.get(rid);
            console.log(rid, prev);
            if (rdoc.status === 1 && prev !== 1) {
                if (rdoc.uid === user._id) {
                    if (!rdoc.contest) {
                        showCongrats();
                    }
                }
            }
            prevStatus.set(rid, rdoc.status);
        } catch (e) {
            console.warn('[ac-celebration] ignore invalid websocket message', e);
        }
    };
}));
