const app = {
    data: {
        users: [],
        admins: [{
            idKerja: 'ADM-001', name: 'Budi Setiawan', password: '123',
            nip: '19850312 201001 1 004', jabatan: 'Petugas Administrasi Kependudukan',
            unitKerja: 'Dinas Kependudukan dan Pencatatan Sipil', wilayah: 'Kantor Pelayanan Adminduk Pusat',
            email: 'budi.setiawan@disdukcapil.go.id', phone: '0812-3456-7801', role: 'Administrator Data Penduduk',
            hakAkses: ['Kelola data penduduk', 'Unggah dokumen kependudukan', 'Menangani tiket Helpdesk']
        }],
        currentAdmin: null,
        helpdeskTickets: [],
        helpdeskCategories: [],
        activeTicketId: null,
        currentUser: null,
        documents: [],
        notifications: [],
        history: [],
        shareState: { selectedDoc: null, target: '', duration: '5menit' }
    },

    documentTypes: [
        { id: 'ktp', name: 'KTP', icon: 'ph-identification-card' },
        { id: 'kk', name: 'Kartu Keluarga', icon: 'ph-users' },
        { id: 'kia', name: 'KIA', icon: 'ph-address-book' },
        { id: 'akta', name: 'Akta Kelahiran', icon: 'ph-file-text' }
    ],
    claimedUser: null,
    qrTimerInterval: null,
    accessTimerInterval: null,

    async init() {
        this.cacheDOM();
        this.bindAuthEvents();
        this.bindAdminEvents();
        this.bindNikValidators();
        this.setupToastContainer();
        if(this.registerFormUser && new URLSearchParams(window.location.search).get('token') === 'expired') {
            this.openClaimForm('', 'Sesi Anda berakhir karena Token Akses sudah kedaluwarsa (berlaku 3 jam). Silakan klaim ulang token untuk masuk kembali.');
            window.history.replaceState(null, '', window.location.pathname);
        }

        const savedUser = sessionStorage.getItem('siaga_current_user');
        let authenticatedUser = null;
        try {
            authenticatedUser = savedUser ? JSON.parse(savedUser) : null;
        } catch(error) {
            sessionStorage.removeItem('siaga_current_user');
        }

        if(this.adminTableBody) {
            await this.loadUsers();
            this.renderAdminTable();
            this.usersRefreshInterval = setInterval(async () => {
                if(await this.loadUsers()) this.renderAdminTable();
            }, 10000);
        }

        if(document.getElementById('app-page') && !this.adminTableBody) {
            const user = authenticatedUser?.nik ? await this.loadResident(authenticatedUser.nik) : null;
            if(!user) {
                sessionStorage.removeItem('siaga_current_user');
                window.location.href = '../index.html';
                return;
            }
            if(user.tokenStatus !== 'active') {
                // Token berlaku 3 jam: sesi berakhir dan penduduk diarahkan untuk klaim token baru.
                sessionStorage.removeItem('siaga_current_user');
                window.location.href = '../index.html?token=expired';
                return;
            }
            this.data.currentUser = user;
            this.data.documents = user.documents || [];
            await this.loadResidentActivity();
            this.startSessionTimer();
        }

        if(document.getElementById('user-name-display') || document.getElementById('profile-name') || document.getElementById('user-avatar-initial')) {
            this.renderUserData();
            if(document.getElementById('user-avatar-initial')) this.recordResidentActivity('Membuka halaman', document.title);
        }
        if(document.getElementById('security-status-text')) {
            this.loadSecurityStatus();
            this.syncExternalNotifications();
            this.securityRefreshInterval = setInterval(() => {
                this.loadSecurityStatus();
                this.syncExternalNotifications();
            }, 15000);
        }
        if(this.docListContainer) {
            this.renderDocuments();
            this.startAccessDetector();
        }
        if(this.notifListContainer) this.renderNotifications();
        if(this.historyListContainer) this.renderHistory();
        if(this.shareDocList) {
            this.renderShareDocs();
            const pendingId = sessionStorage.getItem('siaga_share_doc_id');
            const input = Array.from(this.shareDocList.querySelectorAll('input[name="share_doc"]')).find(item => item.value === pendingId);
            if(input) this.selectShareDoc(pendingId, input.closest('.doc-select-card'));
            sessionStorage.removeItem('siaga_share_doc_id');
        }
        if(document.getElementById('document-access-view')) this.renderTemporaryAccess();

        // Fitur tambahan: Pengaturan penduduk, Helpdesk penduduk, dan laman Petugas.
        if(document.getElementById('settings-profile-form') && this.data.currentUser) this.initSettingsPage();
        if(document.getElementById('helpdesk-ticket-list') && this.data.currentUser) this.initUserHelpdesk();
        if(this.adminTableBody) this.initAdminExtras();
        if(this.adminTableBody) this.bindAdminDocumentPreviews();
        if(this.shareDocList) this.initShareRecipients();
    },

    cacheDOM() {
        this.loginFormUser = document.getElementById('login-form-user');
        this.registerFormUser = document.getElementById('register-form-user');
        this.loginFormAdmin = document.getElementById('login-form-admin');
        this.adminAddUserForm = document.getElementById('admin-add-user-form');
        this.editUserForm = document.getElementById('edit-user-form');
        this.adminTableBody = document.getElementById('admin-user-table-body');
        this.docListContainer = document.getElementById('document-list-container');
        this.notifListContainer = document.getElementById('notification-list-container');
        this.historyListContainer = document.getElementById('history-list-container');
        this.shareDocList = document.getElementById('share-doc-list');
        this.slidePanel = document.getElementById('slide-in-panel');
        this.slidePanelBody = document.getElementById('slide-panel-body');
    },

    // Semua data penduduk disimpan di server (Netlify Database) agar sama di setiap perangkat.
    async api(path, options = {}) {
        const response = await fetch(path, {
            cache: 'no-store',
            ...options,
            headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
        });
        let result = {};
        try {
            result = await response.json();
        } catch(error) {
            result = {};
        }
        if(!response.ok) {
            const error = new Error(result.error || `Permintaan gagal (${response.status}).`);
            error.status = response.status;
            error.result = result;
            throw error;
        }
        return result;
    },

    async loadUsers() {
        try {
            const result = await this.api('/api/users');
            this.data.users = result.users || [];
            return true;
        } catch(error) {
            if(!this.data.users.length) this.showToast('Gagal memuat data', 'Data penduduk tidak dapat diambil dari server.', 'ph-warning');
            return false;
        }
    },

    async loadResident(nik) {
        try {
            const result = await this.api(`/api/users/${encodeURIComponent(nik)}`);
            return result.user || null;
        } catch(error) {
            return null;
        }
    },

    escape(value) {
        return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    },

    formatTime(value) {
        return new Date(value).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
    },

    toHistoryItem(entry) {
        return { id: entry.id, entity: entry.entity, action: entry.action, desc: entry.description, time: this.formatTime(entry.createdAt), status: entry.status, isSuccess: entry.status === 'Berhasil' };
    },

    async loadResidentActivity() {
        const nik = this.data.currentUser?.nik;
        if(!nik) return;
        try {
            const result = await this.api(`/api/history/${encodeURIComponent(nik)}`);
            this.data.history = (result.history || []).map(entry => this.toHistoryItem(entry));
        } catch(error) {
            this.data.history = [];
        }
        await this.syncExternalNotifications(nik);
    },

    async recordResidentActivity(action, description, user = this.data.currentUser) {
        if(!user) return;
        try {
            const result = await this.api(`/api/history/${encodeURIComponent(user.nik)}`, {
                method: 'POST',
                body: JSON.stringify({ action, description })
            });
            if(this.data.currentUser?.nik === user.nik && result.entry) {
                this.data.history = [this.toHistoryItem(result.entry), ...this.data.history].slice(0, 100);
                this.renderHistory();
            }
        } catch(error) {
            // Aktivitas tetap berjalan walau riwayat gagal tersimpan.
        }
    },

    async syncExternalNotifications(ownerNik = this.data.currentUser?.nik) {
        const nik = ownerNik;
        if(!nik) return;
        try {
            const result = await this.api(`/api/activities/${encodeURIComponent(nik)}`);
            const notifications = (result.events || []).map(item => ({ id: item.id, title: item.title, desc: item.description, time: this.formatTime(item.createdAt), type: item.type, icon: item.icon }));
            if(this.data.currentUser?.nik === nik) {
                this.data.notifications = notifications;
                this.renderNotifications();
            }
        } catch(error) {
            // Notifikasi lama tetap ditampilkan jika server sedang tidak dapat dijangkau.
        }
    },

    switchAuthTab(type) {
        document.querySelectorAll('.auth-tab').forEach(tab => tab.classList.remove('auth-tab--active'));
        document.querySelectorAll('.auth-panel').forEach(panel => panel.classList.remove('auth-panel--active'));
        const index = type === 'user' ? 0 : 1;
        document.querySelectorAll('.auth-tab')[index].classList.add('auth-tab--active');
        document.getElementById(type === 'user' ? 'auth-panel-user' : 'auth-panel-admin').classList.add('auth-panel--active');
    },

    switchUserMode(mode) {
        this.loginFormUser.style.display = mode === 'login' ? 'block' : 'none';
        this.registerFormUser.style.display = mode === 'login' ? 'none' : 'block';
    },

    togglePassword(inputId, button) {
        const input = document.getElementById(inputId);
        if(!input) return;
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        const toggle = button || input.parentElement?.querySelector('.password-toggle');
        if(toggle) {
            const icon = toggle.querySelector('i');
            if(icon) icon.className = show ? 'ph ph-eye' : 'ph ph-eye-slash';
            const label = show ? 'Sembunyikan password' : 'Tampilkan password';
            toggle.setAttribute('aria-label', label);
            toggle.setAttribute('title', label);
            toggle.setAttribute('aria-pressed', String(show));
        }
        input.focus();
    },

    normalizePhone(phone) {
        return String(phone || '').replace(/\D/g, '');
    },

    NIK_LENGTH: 16,

    // Validasi NIK: hanya angka dan wajib 16 digit, dengan peringatan langsung saat mengetik.
    bindNikValidators() {
        ['nik-register', 'add-nik', 'edit-nik'].forEach(id => {
            const input = document.getElementById(id);
            if(!input || input.dataset.nikBound) return;
            input.dataset.nikBound = 'true';
            input.addEventListener('input', () => {
                const digits = input.value.replace(/\D/g, '').slice(0, this.NIK_LENGTH);
                if(input.value !== digits) input.value = digits;
                this.validateNik(input);
            });
            input.addEventListener('invalid', () => this.validateNik(input, true));
        });
    },

    validateNik(input, forceShow = false) {
        const hint = document.getElementById(`${input.id}-hint`);
        const length = input.value.trim().length;
        const valid = length === this.NIK_LENGTH;
        const message = length === 0
            ? `NIK wajib diisi ${this.NIK_LENGTH} digit.`
            : `NIK harus ${this.NIK_LENGTH} digit. Saat ini ${length} digit, kurang ${this.NIK_LENGTH - length} digit lagi.`;
        input.setCustomValidity(valid ? '' : message);
        input.classList.toggle('form__input--invalid', !valid && (length > 0 || forceShow));
        if(hint) {
            const show = length > 0 || forceShow;
            hint.classList.toggle('nik-hint--show', show);
            hint.classList.toggle('nik-hint--error', !valid);
            hint.classList.toggle('nik-hint--ok', valid);
            hint.innerHTML = valid
                ? '<i class="ph ph-check-circle"></i> NIK sudah 16 digit.'
                : `<i class="ph ph-warning-circle"></i> ${this.escape(message)}`;
        }
        return valid;
    },

    ensureValidNik(inputId) {
        const input = document.getElementById(inputId);
        if(!input || this.validateNik(input, true)) return true;
        input.focus();
        input.reportValidity();
        return false;
    },

    openClaimForm(identity = '', message = '') {
        this.switchAuthTab('user');
        this.switchUserMode('register');
        const digits = this.normalizePhone(identity);
        const nikInput = document.getElementById('nik-register');
        const phoneInput = document.getElementById('wa-register');
        if(identity && digits.length === this.NIK_LENGTH && !digits.startsWith('0')) {
            nikInput.value = digits;
            this.validateNik(nikInput);
        } else if(identity) {
            phoneInput.value = identity;
        }
        const notice = document.getElementById('token-expired-notice');
        if(notice) {
            notice.style.display = message ? 'flex' : 'none';
            document.getElementById('token-expired-message').textContent = message;
        }
        (nikInput.value ? phoneInput : nikInput).focus();
    },

    showTokenModal(result) {
        this.claimedUser = { phone: result.phone, token: result.token };
        document.getElementById('token-modal-title').textContent = result.alreadyClaimed ? 'Token Anda Masih Aktif' : 'Token Berhasil Diklaim!';
        document.getElementById('generated-token-text').textContent = result.token;
        document.getElementById('token-expiry-text').textContent = result.expiresAt
            ? `Berlaku 3 jam, sampai ${this.formatTime(result.expiresAt)}. Setelah itu sesi otomatis berakhir dan Anda perlu klaim ulang.`
            : '';
        const emailText = document.getElementById('token-email-text');
        if(emailText) {
            emailText.style.display = result.email ? 'block' : 'none';
            emailText.textContent = result.email ? `Salinan token & notifikasi dikirim ke ${result.email}.` : '';
        }
        this.resetCopyButton();
        document.getElementById('token-modal').classList.add('modal-overlay--open');
    },

    resetCopyButton() {
        const button = document.getElementById('copy-token-btn');
        if(!button) return;
        button.classList.remove('token-copy-btn--copied');
        button.innerHTML = '<i class="ph ph-copy"></i> <span>Salin Token</span>';
    },

    async copyToken() {
        const token = this.claimedUser?.token || document.getElementById('generated-token-text').textContent.trim();
        let copied = false;
        try {
            await navigator.clipboard.writeText(token);
            copied = true;
        } catch(error) {
            const helper = document.createElement('textarea');
            helper.value = token;
            helper.setAttribute('readonly', '');
            helper.style.position = 'fixed';
            helper.style.opacity = '0';
            document.body.appendChild(helper);
            helper.select();
            try { copied = document.execCommand('copy'); } catch(fallbackError) { copied = false; }
            helper.remove();
        }
        const button = document.getElementById('copy-token-btn');
        if(copied) {
            button.classList.add('token-copy-btn--copied');
            button.innerHTML = '<i class="ph ph-check"></i> <span>Token Tersalin</span>';
            clearTimeout(this.copyResetTimeout);
            this.copyResetTimeout = setTimeout(() => this.resetCopyButton(), 2500);
        } else {
            alert('Token tidak dapat disalin otomatis. Silakan salin secara manual.');
        }
    },

    async loadSecurityStatus() {
        const ownerNik = this.data.currentUser?.nik;
        if(!ownerNik) return;
        try {
            const response = await fetch(`/api/security/${encodeURIComponent(ownerNik)}`, { cache: 'no-store' });
            if(response.ok) this.renderSecurityStatus(await response.json());
        } catch(error) {
            const detail = document.getElementById('security-status-detail');
            if(detail) detail.textContent = 'Status keamanan belum dapat diperbarui.';
        }
    },

    renderSecurityStatus(security) {
        const statusText = document.getElementById('security-status-text');
        const statusContainer = document.getElementById('security-status-container');
        const detail = document.getElementById('security-status-detail');
        if(!statusText || !statusContainer || !detail) return;
        statusText.textContent = security.suspicious ? 'Waspada' : 'Aman';
        statusContainer.classList.toggle('text-danger', security.suspicious);
        statusContainer.classList.toggle('text-success', !security.suspicious);
        detail.textContent = security.suspicious
            ? `${security.failedAttempts} percobaan login gagal dalam ${security.windowMinutes} menit terakhir.`
            : `Tidak ada aktivitas mencurigakan (${security.failedAttempts}/${security.threshold} percobaan gagal).`;
    },

    bindAuthEvents() {
        if(this.loginFormUser) {
            this.loginFormUser.addEventListener('submit', async event => {
                event.preventDefault();
                const identity = document.getElementById('phone-login').value.trim();
                const token = document.getElementById('token-login').value.trim().toUpperCase();
                const passwordGroup = document.getElementById('password-login-group');
                const passwordInput = document.getElementById('password-login');
                const password = passwordGroup && passwordGroup.style.display !== 'none' ? passwordInput.value : '';
                let user;
                try {
                    ({ user } = await this.api('/api/login', { method: 'POST', body: JSON.stringify({ identity, token, password }) }));
                } catch(error) {
                    if(error.status === 403 && ['TOKEN_EXPIRED', 'TOKEN_UNCLAIMED'].includes(error.result?.code)) {
                        this.openClaimForm(identity, error.message);
                        return;
                    }
                    if(['PASSWORD_REQUIRED', 'PASSWORD_INVALID'].includes(error.result?.code) && passwordGroup) {
                        const firstPrompt = passwordGroup.style.display === 'none';
                        passwordGroup.style.display = 'block';
                        passwordInput.required = true;
                        passwordInput.focus();
                        if(!firstPrompt || error.result.code === 'PASSWORD_INVALID') alert(error.message);
                        return;
                    }
                    alert(error.status === 401 ? 'NIK, nomor HP, atau Token Akses salah!' : `Login gagal: ${error.message}`);
                    return;
                }
                sessionStorage.setItem('siaga_current_user', JSON.stringify({ nik: user.nik, name: user.name }));
                window.location.href = './dashboard/index.html';
            });
        }

        if(this.registerFormUser) {
            this.registerFormUser.addEventListener('submit', async event => {
                event.preventDefault();
                if(!this.ensureValidNik('nik-register')) return;
                const nik = document.getElementById('nik-register').value.trim();
                const phone = document.getElementById('wa-register').value;
                const emailInput = document.getElementById('email-register');
                const email = emailInput ? emailInput.value.trim() : '';
                if(emailInput && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                    emailInput.focus();
                    alert('Alamat email wajib diisi dengan format yang benar (contoh: nama@email.com).');
                    return;
                }
                let result;
                try {
                    result = await this.api('/api/register', { method: 'POST', body: JSON.stringify({ nik, phone, email }) });
                } catch(error) {
                    alert(error.message);
                    return;
                }
                this.showTokenModal(result);
                this.registerFormUser.reset();
                this.validateNik(document.getElementById('nik-register'));
                document.getElementById('token-expired-notice').style.display = 'none';
            });
        }

        if(this.loginFormAdmin) {
            this.loginFormAdmin.addEventListener('submit', event => {
                event.preventDefault();
                const id = document.getElementById('admin-id').value;
                const password = document.getElementById('admin-pass').value;
                const admin = this.data.admins.find(item => item.idKerja === id && item.password === password);
                if(admin) {
                    // Simpan petugas yang sedang login (tanpa password) untuk ditampilkan di Pengaturan Sistem.
                    const { password: _password, ...profile } = admin;
                    sessionStorage.setItem('siaga_current_admin', JSON.stringify({ ...profile, loginAt: Date.now() }));
                    window.location.href = './admin/index.html';
                }
                else alert('Kredensial Admin Salah! (Petunjuk: ADM-001 / 123)');
            });
        }
    },

    fillClaimedCredentials() {
        if(!this.claimedUser) return;
        document.getElementById('phone-login').value = this.claimedUser.phone;
        document.getElementById('token-login').value = this.claimedUser.token;
    },

    closeTokenModal() {
        document.getElementById('token-modal').classList.remove('modal-overlay--open');
        this.switchUserMode('login');
        this.fillClaimedCredentials();
    },

    bindAdminEvents() {
        if(this.adminAddUserForm) {
            this.adminAddUserForm.addEventListener('submit', async event => {
                event.preventDefault();
                if(!this.ensureValidNik('add-nik')) return;
                const nik = document.getElementById('add-nik').value.trim();
                const name = document.getElementById('add-name').value.trim();
                const phone = document.getElementById('add-wa').value.trim();
                let documents;
                try {
                    documents = await this.readDocuments('add', []);
                    await this.api('/api/users', { method: 'POST', body: JSON.stringify({ nik, name, phone, documents }) });
                } catch(error) {
                    alert(error.message);
                    return;
                }
                await this.loadUsers();
                this.adminAddUserForm.reset();
                this.validateNik(document.getElementById('add-nik'));
                this.renderAdminTable();
                this.switchAdminPanel('tabel');
                alert('Data penduduk berhasil ditambahkan.');
            });
        }

        if(this.editUserForm) {
            this.editUserForm.addEventListener('submit', async event => {
                event.preventDefault();
                const originalNik = document.getElementById('edit-original-nik').value;
                const user = this.data.users.find(item => item.nik === originalNik);
                const nik = document.getElementById('edit-nik').value.trim();
                if(!user) return;
                if(!this.ensureValidNik('edit-nik')) return;
                try {
                    // Hanya dokumen yang baru diunggah yang dikirim; dokumen lama tetap tersimpan di server.
                    const documents = await this.readDocuments('edit', []);
                    await this.api(`/api/users/${encodeURIComponent(originalNik)}`, {
                        method: 'PUT',
                        body: JSON.stringify({
                            nik,
                            name: document.getElementById('edit-name').value.trim(),
                            phone: document.getElementById('edit-wa').value.trim(),
                            documents
                        })
                    });
                } catch(error) {
                    alert(error.message);
                    return;
                }
                await this.loadUsers();
                this.closeEditUser();
                this.renderAdminTable();
                alert('Data penduduk berhasil diperbarui.');
            });
        }
    },

    async readDocuments(prefix, existingDocuments) {
        const documents = [...existingDocuments];
        for(const type of this.documentTypes) {
            const input = document.getElementById(`${prefix}-doc-${type.id}`);
            const file = input && input.files[0];
            if(!file) continue;
            const extension = file.name.split('.').pop().toLowerCase();
            if(!['png', 'pdf'].includes(extension) || !['image/png', 'application/pdf'].includes(file.type)) throw new Error(`${type.name} hanya menerima file PNG atau PDF.`);
            if(file.size > 1024 * 1024) throw new Error(`${type.name} maksimal berukuran 1 MB.`);
            const fileData = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = () => reject(new Error(`File ${type.name} tidak dapat dibaca.`));
                reader.readAsDataURL(file);
            });
            const record = { id: type.id, name: type.name, status: 'Aman', icon: type.icon, validity: 'Dokumen tersimpan', fileName: file.name, fileType: file.type, fileData };
            const index = documents.findIndex(item => item.id === type.id);
            if(index < 0) documents.push(record);
            else documents[index] = record;
        }
        return documents;
    },

    adminPanelTitles: { tabel: 'Data Penduduk', input: 'Input Penduduk Baru', helpdesk: 'Helpdesk', pengaturan: 'Pengaturan Sistem' },

    switchAdminPanel(panelName) {
        document.querySelectorAll('.sidebar__link').forEach(link => link.classList.toggle('sidebar__link--active', link.dataset.adminPanel === panelName));
        Object.keys(this.adminPanelTitles).forEach(name => {
            const panel = document.getElementById(`admin-panel-${name}`);
            if(panel) panel.classList.toggle('panel--active', panelName === name);
        });
        document.getElementById('page-title').textContent = this.adminPanelTitles[panelName] || 'Data Penduduk';
        if(panelName === 'helpdesk') this.loadAdminHelpdesk();
        if(panelName === 'pengaturan') this.renderAdminAccount();
    },

    renderAdminTable() {
        if(!this.adminTableBody) return;
        const search = document.getElementById('admin-search');
        const query = (search?.value || '').trim().toLowerCase();
        if(search && !search.dataset.bound) {
            search.dataset.bound = 'true';
            search.addEventListener('input', () => this.renderAdminTable());
        }
        const users = this.data.users.filter(user => !query || user.nik.includes(query) || (user.name || '').toLowerCase().includes(query));
        if(!users.length) {
            this.adminTableBody.innerHTML = `<tr><td colspan="7" class="text-muted" style="text-align:center;">${query ? 'Tidak ada data yang cocok.' : 'Belum ada data penduduk.'}</td></tr>`;
            return;
        }
        this.adminTableBody.innerHTML = users.map((user, index) => `
            <tr>
                <td>${index + 1}</td>
                <td><strong>${this.escape(user.nik)}</strong></td>
                <td>${this.escape(user.name)}</td>
                <td>${this.escape(user.phone || '-')}</td>
                <td>${(user.documents || []).map(doc => `<span class="pill pill--success" style="margin:0.1rem;">${this.escape(doc.name)}</span>`).join('') || '<span class="text-muted">Belum ada</span>'}</td>
                <td>${this.tokenStatusMarkup(user)}</td>
                <td><button class="btn btn--outline" style="padding:0.45rem 0.75rem;" onclick="app.openEditUser('${this.escape(user.nik)}')"><i class="ph ph-pencil-simple"></i> Edit</button></td>
            </tr>`).join('');
    },

    tokenStatusMarkup(user) {
        if(user.tokenStatus === 'active') return `<span class="pill pill--success">${this.escape(user.token)}</span><div class="text-muted" style="font-size:0.75rem;margin-top:0.25rem">s.d. ${this.escape(this.formatTime(user.tokenExpiresAt))}</div>`;
        if(user.tokenStatus === 'expired') return '<span class="pill pill--danger">Kedaluwarsa</span><div class="text-muted" style="font-size:0.75rem;margin-top:0.25rem">Menunggu klaim ulang</div>';
        return '<span class="pill pill--warning">Belum Klaim</span>';
    },

    openEditUser(nik) {
        const user = this.data.users.find(item => item.nik === nik);
        if(!user) return;
        this.editUserForm.reset();
        document.getElementById('edit-original-nik').value = user.nik;
        document.getElementById('edit-nik').value = user.nik;
        document.getElementById('edit-name').value = user.name;
        document.getElementById('edit-wa').value = user.phone || '';
        this.validateNik(document.getElementById('edit-nik'));
        document.getElementById('edit-user-modal').classList.add('modal-overlay--open');
    },

    closeEditUser() {
        if(this.editUserForm) this.editUserForm.reset();
        const modal = document.getElementById('edit-user-modal');
        if(modal) modal.classList.remove('modal-overlay--open');
    },

    renderUserData() {
        const user = this.data.currentUser;
        if(!user) return;
        const initial = (user.name || '').trim().charAt(0).toUpperCase();
        const nameDisplay = document.getElementById('user-name-display');
        const avatar = document.getElementById('user-avatar-initial');
        const docCount = document.getElementById('doc-count');
        const profileName = document.getElementById('profile-name');
        const profileNik = document.getElementById('profile-nik');
        if(nameDisplay) nameDisplay.textContent = user.name;
        if(avatar) avatar.textContent = initial;
        if(docCount) docCount.textContent = (user.documents || []).length;
        if(profileName) profileName.textContent = user.name;
        if(profileNik) profileNik.textContent = `NIK ${user.nik}`;
    },

    docFilter: 'all',

    // Dokumen berstatus "Aman" dianggap aktif; status lain perlu diperbarui.
    isDocActive(doc) {
        return (doc.status || 'Aman') === 'Aman';
    },

    bindDocFilterTabs() {
        const tabs = document.getElementById('doc-filter-tabs');
        if(!tabs || tabs.dataset.bound) return;
        tabs.dataset.bound = '1';
        tabs.addEventListener('click', event => {
            const tab = event.target.closest('.tab[data-filter]');
            if(!tab) return;
            this.docFilter = tab.dataset.filter;
            this.renderDocuments();
        });
    },

    renderDocuments() {
        if(!this.docListContainer) return;
        this.bindDocFilterTabs();
        const allDocuments = this.data.currentUser?.documents || [];
        const counts = {
            all: allDocuments.length,
            active: allDocuments.filter(doc => this.isDocActive(doc)).length,
            update: allDocuments.filter(doc => !this.isDocActive(doc)).length
        };
        document.querySelectorAll('#doc-filter-tabs .tab[data-filter]').forEach(tab => {
            const isActive = tab.dataset.filter === this.docFilter;
            tab.classList.toggle('tab--active', isActive);
            tab.setAttribute('aria-selected', String(isActive));
            const count = tab.querySelector('.tab__count');
            if(count) count.textContent = counts[tab.dataset.filter] ?? 0;
        });
        if(!allDocuments.length) {
            this.docListContainer.innerHTML = '<div class="alert alert--warning"><i class="ph ph-folder-open"></i><span>Belum ada dokumen yang dimasukkan petugas.</span></div>';
            return;
        }
        const documents = allDocuments.filter(doc => this.docFilter === 'all' || (this.docFilter === 'active' ? this.isDocActive(doc) : !this.isDocActive(doc)));
        if(!documents.length) {
            this.docListContainer.innerHTML = this.docFilter === 'active'
                ? '<div class="alert alert--warning"><i class="ph ph-info"></i><span>Belum ada dokumen yang berstatus aktif.</span></div>'
                : '<div class="alert alert--success"><i class="ph ph-check-circle"></i><span>Semua dokumen Anda masih aktif. Tidak ada dokumen yang perlu diperbarui.</span></div>';
            return;
        }
        this.docListContainer.innerHTML = documents.map(doc => `
            <div class="doc-card" onclick='app.openDocumentDetail(${JSON.stringify(doc.id)})'>
                <div class="doc-card__icon"><i class="ph ${doc.icon}"></i></div>
                <div class="doc-card__info"><h5>${doc.name}</h5><p class="text-muted" style="font-size:0.8rem;margin-bottom:0.5rem">${doc.validity}</p><span class="pill ${doc.status === 'Aman' ? 'pill--success' : 'pill--warning'}"><i class="ph ph-check-circle"></i> ${doc.status}</span></div>
                <i class="ph ph-caret-right text-muted"></i>
            </div>`).join('');
    },

    renderNotifications() {
        if(!this.notifListContainer) return;
        this.notifListContainer.innerHTML = this.data.notifications.map(notif => `
            <div class="list-item"><div class="list-item__icon"><i class="ph ${notif.icon}"></i></div><div class="list-item__content"><h6>${notif.title}</h6><p>${notif.desc}</p></div><div class="list-item__meta">${notif.time}</div></div>`).join('');
    },

    renderHistory() {
        if(!this.historyListContainer) return;
        this.historyListContainer.innerHTML = this.data.history.map(item => `
            <div class="list-item"><div class="list-item__icon"><i class="ph ph-buildings"></i></div><div class="list-item__content"><h6>${item.entity}</h6><p>${item.desc}</p></div><div class="list-item__meta"><div>${item.time}</div><strong>${item.status}</strong></div></div>`).join('');
    },

    renderShareDocs() {
        if(!this.shareDocList) return;
        const documents = this.data.currentUser?.documents || [];
        if(!documents.length) {
            this.shareDocList.innerHTML = '<div class="alert alert--warning"><i class="ph ph-folder-open"></i><span>Belum ada dokumen yang dapat dibagikan.</span></div>';
            return;
        }
        this.shareDocList.innerHTML = documents.map(doc => `
            <label class="doc-select-card" onclick='app.selectShareDoc(${JSON.stringify(doc.id)}, this)'><input type="radio" name="share_doc" value="${doc.id}"><div style="flex:1"><strong style="display:block;margin-bottom:0.25rem">${doc.name}</strong><span class="text-muted">${doc.fileName || ''}</span></div></label>`).join('');
    },

    selectShareDoc(id, element) {
        document.querySelectorAll('.doc-select-card').forEach(card => card.classList.remove('selected'));
        element.classList.add('selected');
        const input = element.querySelector('input[name="share_doc"]');
        if(input) input.checked = true;
        this.data.shareState.selectedDoc = (this.data.currentUser?.documents || []).find(doc => String(doc.id) === String(id));
    },

    nextShareStep(stepNumber) {
        if(stepNumber > 1 && !this.data.shareState.selectedDoc) {
            alert('Pilih dokumen terlebih dahulu.');
            return;
        }
        if(stepNumber === 3 && document.getElementById('share-recipient-grid')) {
            const target = document.getElementById('share-target').value.trim();
            if(!target) {
                alert('Pilih penerima dokumen atau isi nama penerima lainnya terlebih dahulu.');
                return;
            }
            const purposeSelect = document.getElementById('share-purpose');
            const custom = document.getElementById('share-purpose-custom');
            this.data.shareState.purpose = purposeSelect.value === 'Lainnya' ? (custom.value.trim() || 'Lainnya') : purposeSelect.value;
            if(!this.data.shareState.purpose) {
                alert('Pilih tujuan penggunaan dokumen.');
                purposeSelect.focus();
                return;
            }
        }
        document.querySelectorAll('.share-step').forEach(step => step.classList.remove('share-step--active'));
        const currentStep = document.getElementById(`share-step-${stepNumber}`);
        if(currentStep) currentStep.classList.add('share-step--active');
        document.querySelectorAll('.stepper__step').forEach((step, index) => step.classList.toggle('stepper__step--active', index < stepNumber));
        if(stepNumber === 3) {
            const doc = this.data.shareState.selectedDoc;
            const target = document.getElementById('share-target').value.trim() || 'Instansi Umum';
            document.getElementById('preview-target-name').textContent = target;
            document.getElementById('preview-duration').textContent = '5 Menit';
            const purposeEl = document.getElementById('preview-purpose');
            if(purposeEl) purposeEl.textContent = this.data.shareState.purpose || '-';
            const categoryEl = document.getElementById('preview-category');
            if(categoryEl) categoryEl.textContent = this.data.shareState.category || 'Lainnya';
            document.getElementById('share-document-name').textContent = doc.name;
            document.getElementById('share-document-preview').innerHTML = `${this.documentPreviewMarkup(doc, '260px')}<div class="watermark-overlay"><span id="watermark-text">UNTUK ${target.toUpperCase()} - ${new Date().toLocaleDateString('id-ID')}</span></div>`;
        }
    },

    documentPreviewMarkup(doc, height = '320px') {
        if(!doc?.fileData) return '<div class="document-preview document-preview--empty"><i class="ph ph-file"></i><span>File dokumen tidak tersedia</span></div>';
        if(doc.fileType === 'application/pdf' || (doc.fileName || '').toLowerCase().endsWith('.pdf')) return `<iframe title="Preview ${doc.name}" src="${doc.fileData}" style="width:100%;height:${height};border:0;background:#fff"></iframe>`;
        return `<img src="${doc.fileData}" alt="Preview ${doc.name}" style="max-width:100%;max-height:${height};object-fit:contain">`;
    },

    async submitShare() {
        const doc = this.data.shareState.selectedDoc;
        if(!doc?.fileData) {
            alert('Dokumen yang dipilih tidak memiliki file untuk dibagikan.');
            return;
        }
        const share = await this.createTemporaryShare(doc);
        if(share) this.showTemporaryShare(share);
        if(share) this.recordResidentActivity('Membagikan dokumen', `Membagikan ${doc.name} kepada ${document.getElementById('share-target').value.trim() || 'Instansi Umum'}.`);
    },

    async createTemporaryShare(doc) {
        try {
            const response = await fetch('/api/shares', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    documentId: doc.id,
                    ownerNik: this.data.currentUser?.nik,
                    target: document.getElementById('share-target')?.value.trim() || 'Instansi Umum',
                    targetCategory: this.data.shareState.category || '',
                    purpose: this.data.shareState.purpose || ''
                })
            });
            const result = await response.json();
            if(!response.ok) throw new Error(result.error || 'Tautan dokumen tidak dapat dibuat.');
            return { ...result, document: doc };
        } catch(error) {
            alert(`Tautan dokumen tidak dapat dibuat (${error.message}). Periksa koneksi internet lalu coba lagi.`);
            return null;
        }
    },

    async loadQRCodeLibrary() {
        if(window.QRCode) return true;
        return new Promise(resolve => {
            const script = document.createElement('script');
            script.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
            script.onload = () => resolve(Boolean(window.QRCode));
            script.onerror = () => resolve(false);
            document.head.appendChild(script);
        });
    },

    async showTemporaryShare(share) {
        if(!document.getElementById('qr-modal')) document.body.insertAdjacentHTML('beforeend', '<div id="qr-modal" class="modal-overlay"><div class="modal-content"><h3 id="qr-doc-title"></h3><p class="text-muted">Akses dokumen berakhir dalam 5 menit.</p><div id="temporary-qr-code" class="qr-box"></div><a id="temporary-share-link" target="_blank" rel="noopener" style="display:block;overflow-wrap:anywhere"></a><div class="timer-text" id="qr-timer">05:00</div><div class="form-actions mt-4"><button class="btn btn--danger btn--full" onclick="app.closeQRModal()">Tutup</button></div></div></div>');
        document.getElementById('qr-doc-title').textContent = share.document.name;
        const link = document.getElementById('temporary-share-link');
        link.href = share.url;
        link.textContent = share.url;
        const qrBox = document.getElementById('temporary-qr-code');
        qrBox.innerHTML = '';
        if(await this.loadQRCodeLibrary()) new QRCode(qrBox, { text: share.url, width: 180, height: 180 });
        else qrBox.textContent = 'QR tidak tersedia. Gunakan tautan di atas.';
        document.getElementById('qr-modal').classList.add('modal-overlay--open');
        clearInterval(this.qrTimerInterval);
        this.qrTimerInterval = setInterval(() => {
            const remaining = Math.max(0, share.expiresAt - Date.now());
            document.getElementById('qr-timer').textContent = `${String(Math.floor(remaining / 60000)).padStart(2, '0')}:${String(Math.floor(remaining % 60000 / 1000)).padStart(2, '0')}`;
            if(remaining <= 0) {
                clearInterval(this.qrTimerInterval);
                document.getElementById('qr-timer').textContent = 'KADALUARSA';
                qrBox.textContent = 'Akses telah berakhir.';
            }
        }, 1000);
    },

    openDocumentDetail(id) {
        if(!this.slidePanelBody) return;
        const doc = (this.data.currentUser?.documents || []).find(item => String(item.id) === String(id));
        if(!doc) return;
        this.recordResidentActivity('Membuka dokumen', `Membuka preview ${doc.name}.`);
        this.slidePanelBody.innerHTML = `<div style="text-align:center;padding:2rem 0">${this.documentPreviewMarkup(doc)}<h2 style="margin-top:1rem">${doc.name}</h2><p class="text-muted">${doc.validity}</p></div><h4 class="section-title mt-4">Status Keamanan</h4><div class="alert alert--info"><i class="ph ph-shield-check"></i><span>Dokumen ini dilindungi.</span></div><div class="form-actions mt-4" style="display:flex;flex-direction:column;gap:1rem"><button class="btn btn--primary btn--full" onclick='app.shareDocument(${JSON.stringify(doc.id)})'><i class="ph ph-share-network"></i> Bagikan (Secure Share)</button><button class="btn btn--outline btn--full" onclick='app.generateQR(${JSON.stringify(doc.id)})'><i class="ph ph-qr-code"></i> Buat QR Akses Sementara</button></div>`;
        this.slidePanel.classList.add('slide-panel--open');
    },

    shareDocument(id) {
        const doc = (this.data.currentUser?.documents || []).find(item => String(item.id) === String(id));
        if(doc) this.recordResidentActivity('Membuka Secure Share', `Memulai proses berbagi ${doc.name}.`);
        sessionStorage.setItem('siaga_share_doc_id', String(id));
        window.location.href = '../secureshare/index.html';
    },

    closeSlidePanel() {
        if(this.slidePanel) this.slidePanel.classList.remove('slide-panel--open');
    },

    async generateQR(id) {
        const doc = (this.data.currentUser?.documents || []).find(item => String(item.id) === String(id));
        if(!doc?.fileData) {
            alert('File dokumen tidak tersedia untuk dibuatkan QR.');
            return;
        }
        const share = await this.createTemporaryShare(doc);
        if(share) this.showTemporaryShare(share);
        if(share) this.recordResidentActivity('Membuat QR dokumen', `Membuat tautan QR sementara untuk ${doc.name}.`);
    },

    async renderTemporaryAccess() {
        const container = document.getElementById('document-access-view');
        const id = new URLSearchParams(window.location.search).get('id');
        if(!id) {
            container.innerHTML = '<h1>Akses dokumen tidak valid</h1><p>Tautan tidak memiliki kode akses.</p>';
            return;
        }
        let share = null;
        let connectionFailed = false;
        try {
            const response = await fetch(`/api/shares/${encodeURIComponent(id)}`, { cache: 'no-store' });
            if(response.ok) share = await response.json();
        } catch(error) {
            connectionFailed = true;
        }
        if(connectionFailed) {
            container.innerHTML = '<h1>Server tidak dapat dijangkau</h1><p>Periksa koneksi internet perangkat Anda lalu muat ulang halaman.</p>';
            return;
        }
        if(!share?.document || share.expiresAt <= Date.now()) {
            container.innerHTML = '<h1>Akses dokumen berakhir</h1><p>Tautan tidak valid atau masa akses 5 menit sudah habis.</p>';
            return;
        }
        container.innerHTML = '<h1 id="temporary-document-title"></h1><p id="temporary-access-countdown"></p><div id="temporary-document-content"></div>';
        document.getElementById('temporary-document-title').textContent = share.document.name;
        document.getElementById('temporary-access-countdown').textContent = 'Akses berlaku selama 5 menit.';
        document.getElementById('temporary-document-content').innerHTML = this.documentPreviewMarkup(share.document, '75vh');
        clearInterval(this.accessTimerInterval);
        this.accessTimerInterval = setInterval(() => {
            const remaining = share.expiresAt - Date.now();
            if(remaining <= 0) {
                clearInterval(this.accessTimerInterval);
                container.innerHTML = '<h1>Akses dokumen berakhir</h1><p>Waktu akses 5 menit telah habis.</p>';
            } else {
                const seconds = Math.ceil(remaining / 1000);
                document.getElementById('temporary-access-countdown').textContent = `Akses berakhir dalam ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}.`;
            }
        }, 1000);
    },

    closeQRModal() {
        clearInterval(this.qrTimerInterval);
        const modal = document.getElementById('qr-modal');
        if(modal) modal.classList.remove('modal-overlay--open');
    },

    renderNotifications() {
        if(!this.notifListContainer) return;
        this.notifListContainer.innerHTML = this.data.notifications.map(item => `<div class="list-item"><div class="list-item__icon"><i class="ph ${this.escape(item.icon)}"></i></div><div class="list-item__content"><h6>${this.escape(item.title)}</h6><p>${this.escape(item.desc)}</p></div><div class="list-item__meta">${this.escape(item.time)}</div></div>`).join('');
    },

    renderHistory() {
        if(!this.historyListContainer) return;
        if(!this.data.history.length) {
            this.historyListContainer.innerHTML = '<div class="alert alert--info"><i class="ph ph-clock-counter-clockwise"></i><span>Belum ada aktivitas penduduk.</span></div>';
            return;
        }
        this.historyListContainer.innerHTML = this.data.history.map(item => `<div class="list-item"><div class="list-item__icon"><i class="ph ph-clock-counter-clockwise"></i></div><div class="list-item__content"><h6>${this.escape(item.action || item.entity)}</h6><p>${this.escape(item.desc)}</p><span class="text-muted">${this.escape(item.entity)}</span></div><div class="list-item__meta"><div>${this.escape(item.time)}</div><strong>${this.escape(item.status)}</strong></div></div>`).join('');
    },

    // ==========================================================================
    // PENGATURAN PENDUDUK: profil, data diri, password akun, preferensi keamanan
    // ==========================================================================
    PROFILE_FIELDS: ['email', 'birthPlace', 'birthDate', 'gender', 'religion', 'maritalStatus', 'occupation', 'address'],

    residentHeaders() {
        return { 'X-Siaga-Token': this.data.currentUser?.token || '' };
    },

    async residentApi(path, options = {}) {
        try {
            return await this.api(path, { ...options, headers: { ...this.residentHeaders(), ...(options.headers || {}) } });
        } catch(error) {
            if(error.result?.code === 'SESSION_INVALID') {
                sessionStorage.removeItem('siaga_current_user');
                alert(error.message);
                window.location.href = '../index.html?token=expired';
            }
            throw error;
        }
    },

    showSettingsStatus(message, type = 'success') {
        const box = document.getElementById('settings-status');
        if(!box) return alert(message);
        box.className = `alert settings-status alert--${type === 'error' ? 'danger' : type === 'success' ? 'success' : 'info'}`;
        box.innerHTML = `<i class="ph ${type === 'error' ? 'ph-warning-circle' : 'ph-check-circle'}"></i><span>${this.escape(message)}</span>`;
        box.style.display = 'flex';
        box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        clearTimeout(this.settingsStatusTimeout);
        this.settingsStatusTimeout = setTimeout(() => { box.style.display = 'none'; }, 6000);
    },

    initSettingsPage() {
        this.fillSettingsForm();
        const profileForm = document.getElementById('settings-profile-form');
        profileForm.addEventListener('submit', event => this.saveProfile(event));
        profileForm.addEventListener('input', () => this.updateProfileCompleteness(true));
        document.getElementById('settings-password-form').addEventListener('submit', event => this.saveAccountPassword(event));
        document.getElementById('new-password').addEventListener('input', () => this.renderPasswordStrength());
        ['twoFactor', 'biometric'].forEach(key => {
            const toggle = document.getElementById(`setting-${key}`);
            if(toggle) toggle.addEventListener('change', () => this.saveSecuritySetting(key, toggle.checked));
        });
        if(window.location.hash === '#password') this.togglePasswordForm(true);
        if(window.location.hash) document.getElementById(window.location.hash.slice(1))?.scrollIntoView();
    },

    fillSettingsForm() {
        const user = this.data.currentUser;
        const profile = user.profile || {};
        document.getElementById('settings-nik').value = user.nik;
        document.getElementById('settings-name').value = user.name || '';
        document.getElementById('settings-phone').value = user.phone || '';
        this.PROFILE_FIELDS.forEach(field => {
            const input = document.getElementById(`settings-${field}`);
            if(input) input.value = profile[field] || '';
        });
        const settings = user.settings || {};
        ['twoFactor', 'biometric'].forEach(key => {
            const toggle = document.getElementById(`setting-${key}`);
            if(toggle) toggle.checked = settings[key] !== false;
        });
        this.updateProfileCompleteness();
        this.renderPasswordSettingState();
        const statusLabels = { active: 'Aktif', expired: 'Kedaluwarsa', unclaimed: 'Belum Diklaim' };
        document.getElementById('settings-token-status').textContent = statusLabels[user.tokenStatus] || '-';
        document.getElementById('settings-token-expiry').textContent = user.tokenExpiresAt ? this.formatTime(user.tokenExpiresAt) : '-';
        document.getElementById('settings-updated-at').textContent = user.updatedAt ? this.formatTime(user.updatedAt) : '-';
    },

    updateProfileCompleteness(fromForm = false) {
        const values = ['phone', ...this.PROFILE_FIELDS].map(field => fromForm
            ? document.getElementById(`settings-${field}`)?.value.trim()
            : (field === 'phone' ? this.data.currentUser.phone : this.data.currentUser.profile?.[field]));
        const percent = Math.round(values.filter(Boolean).length / values.length * 100);
        document.getElementById('profile-completeness-value').textContent = `${percent}%`;
        const bar = document.getElementById('profile-completeness-bar');
        bar.style.width = `${percent}%`;
        bar.classList.toggle('progress__bar--complete', percent === 100);
    },

    async saveProfile(event) {
        event.preventDefault();
        const nik = this.data.currentUser.nik;
        const profile = {};
        this.PROFILE_FIELDS.forEach(field => { profile[field] = document.getElementById(`settings-${field}`).value.trim(); });
        const phone = document.getElementById('settings-phone').value.trim();
        const button = event.submitter;
        if(button) button.disabled = true;
        try {
            const { user } = await this.residentApi(`/api/users/${encodeURIComponent(nik)}/profile`, { method: 'PUT', body: JSON.stringify({ phone, profile }) });
            this.data.currentUser = user;
            this.fillSettingsForm();
            this.showSettingsStatus('Profil dan data diri berhasil disimpan.');
            this.recordResidentActivity('Memperbarui profil', 'Memperbarui data diri melalui menu Pengaturan.');
        } catch(error) {
            this.showSettingsStatus(error.message, 'error');
        } finally {
            if(button) button.disabled = false;
        }
    },

    togglePasswordForm(forceOpen) {
        const form = document.getElementById('settings-password-form');
        const open = forceOpen ?? form.style.display === 'none';
        form.style.display = open ? 'block' : 'none';
        document.getElementById('password-form-caret').className = open ? 'ph ph-caret-down' : 'ph ph-caret-right';
        if(open) (this.data.currentUser.hasPassword ? document.getElementById('current-password') : document.getElementById('new-password')).focus();
    },

    renderPasswordSettingState() {
        const hasPassword = Boolean(this.data.currentUser.hasPassword);
        document.getElementById('current-password-group').style.display = hasPassword ? 'block' : 'none';
        document.getElementById('remove-password-btn').style.display = hasPassword ? 'inline-flex' : 'none';
        document.getElementById('password-setting-desc').textContent = hasPassword
            ? `Password aktif${this.data.currentUser.passwordUpdatedAt ? ` · diubah ${this.formatTime(this.data.currentUser.passwordUpdatedAt)}` : ''}`
            : 'Belum aktif · tambahkan password untuk keamanan ekstra';
    },

    passwordScore(value) {
        let score = 0;
        if(value.length >= 8) score++;
        if(/[a-z]/.test(value) && /[A-Z]/.test(value)) score++;
        if(/\d/.test(value)) score++;
        if(/[^A-Za-z0-9]/.test(value)) score++;
        if(value.length >= 12) score++;
        return score;
    },

    renderPasswordStrength() {
        const value = document.getElementById('new-password').value;
        const hint = document.getElementById('password-strength');
        if(!value) { hint.textContent = ''; hint.className = 'password-strength'; return; }
        const score = this.passwordScore(value);
        const level = score <= 2 ? ['Lemah', 'weak'] : score <= 3 ? ['Sedang', 'medium'] : ['Kuat', 'strong'];
        hint.className = `password-strength password-strength--${level[1]}`;
        hint.textContent = `Kekuatan password: ${level[0]}`;
    },

    async saveAccountPassword(event) {
        event.preventDefault();
        const currentPassword = document.getElementById('current-password').value;
        const newPassword = document.getElementById('new-password').value;
        const confirmPassword = document.getElementById('confirm-password').value;
        if(this.data.currentUser.hasPassword && !currentPassword) return this.showSettingsStatus('Masukkan password saat ini.', 'error');
        if(newPassword.length < 8 || !/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) return this.showSettingsStatus('Password baru minimal 8 karakter dan mengandung huruf serta angka.', 'error');
        if(newPassword !== confirmPassword) return this.showSettingsStatus('Konfirmasi password tidak sama dengan password baru.', 'error');
        await this.submitPasswordChange({ currentPassword, newPassword }, 'Password akun berhasil disimpan. Gunakan password ini bersama Token Akses saat login berikutnya.', 'Mengubah password akun.');
    },

    async removeAccountPassword() {
        const currentPassword = document.getElementById('current-password').value;
        if(!currentPassword) return this.showSettingsStatus('Masukkan password saat ini untuk menonaktifkan password.', 'error');
        if(!confirm('Nonaktifkan password akun? Login hanya akan memerlukan Token Akses.')) return;
        await this.submitPasswordChange({ currentPassword, remove: true }, 'Password akun dinonaktifkan.', 'Menonaktifkan password akun.');
    },

    async submitPasswordChange(payload, successMessage, historyDescription) {
        try {
            const { user } = await this.residentApi(`/api/users/${encodeURIComponent(this.data.currentUser.nik)}/password`, { method: 'PUT', body: JSON.stringify(payload) });
            this.data.currentUser = user;
            document.getElementById('settings-password-form').reset();
            this.renderPasswordStrength();
            this.renderPasswordSettingState();
            this.togglePasswordForm(false);
            this.showSettingsStatus(successMessage);
            this.recordResidentActivity('Keamanan akun', historyDescription);
        } catch(error) {
            this.showSettingsStatus(error.message, 'error');
        }
    },

    async saveSecuritySetting(key, value) {
        try {
            const { user } = await this.residentApi(`/api/users/${encodeURIComponent(this.data.currentUser.nik)}/settings`, { method: 'PUT', body: JSON.stringify({ [key]: value }) });
            this.data.currentUser = user;
            const label = key === 'twoFactor' ? 'Verifikasi 2 Langkah' : 'Biometrik';
            this.showToast('Pengaturan disimpan', `${label} ${value ? 'diaktifkan' : 'dinonaktifkan'}.`, 'ph-check-circle');
        } catch(error) {
            const toggle = document.getElementById(`setting-${key}`);
            if(toggle) toggle.checked = !value;
            this.showSettingsStatus(error.message, 'error');
        }
    },

    // ==========================================================================
    // HELPDESK: tiket penduduk <-> petugas
    // ==========================================================================
    ticketStatusMeta(status) {
        return {
            open: { label: 'Menunggu Petugas', cls: 'pill--warning' },
            answered: { label: 'Dibalas Petugas', cls: 'pill--success' },
            closed: { label: 'Selesai', cls: 'pill--muted' }
        }[status] || { label: status, cls: 'pill--warning' };
    },

    renderTicketList(container, tickets, viewer, emptyMessage) {
        if(!tickets.length) {
            container.innerHTML = `<div class="alert alert--info"><i class="ph ph-chats-circle"></i><span>${this.escape(emptyMessage)}</span></div>`;
            return;
        }
        container.innerHTML = tickets.map(ticket => {
            const status = this.ticketStatusMeta(ticket.status);
            const last = ticket.messages[ticket.messages.length - 1];
            const who = viewer === 'admin' ? `${this.escape(ticket.residentName)} · ${this.escape(ticket.nik)}` : this.escape(ticket.category);
            return `<button type="button" class="ticket-item ${ticket.id === this.activeTicketId ? 'ticket-item--active' : ''} ${ticket.unread ? 'ticket-item--unread' : ''}" onclick="app.selectTicket(${ticket.id}, '${viewer}')">
                <div class="ticket-item__top"><strong>#${ticket.id} ${this.escape(ticket.subject)}</strong>${ticket.unread ? '<span class="ticket-dot" title="Pesan baru"></span>' : ''}</div>
                <div class="ticket-item__meta">${who}</div>
                <p class="ticket-item__preview">${this.escape(last ? `${last.sender === 'admin' ? 'Petugas' : (viewer === 'admin' ? 'Penduduk' : 'Anda')}: ${last.body}` : '')}</p>
                <div class="ticket-item__footer"><span class="pill ${status.cls}">${status.label}</span><span>${this.escape(this.formatTime(ticket.updatedAt))}</span></div>
            </button>`;
        }).join('');
    },

    renderTicketThread(container, ticket, viewer) {
        if(!ticket) {
            container.innerHTML = '<div class="helpdesk-empty"><i class="ph ph-chats-circle"></i><p>Pilih tiket untuk melihat percakapan.</p></div>';
            container.dataset.signature = '';
            return;
        }
        // Hindari render ulang (dan hilangnya ketikan balasan) bila tidak ada perubahan.
        const signature = `${ticket.id}:${ticket.messages.length}:${ticket.status}`;
        if(container.dataset.signature === signature) return;
        const draft = container.dataset.ticketId === String(ticket.id) ? container.querySelector('.helpdesk-reply textarea')?.value || '' : '';
        container.dataset.signature = signature;
        container.dataset.ticketId = String(ticket.id);
        const status = this.ticketStatusMeta(ticket.status);
        const actions = viewer === 'admin'
            ? (ticket.status === 'closed'
                ? `<button type="button" class="btn btn--outline btn--sm" onclick="app.updateTicketStatus(${ticket.id}, 'reopen', 'admin')"><i class="ph ph-arrow-counter-clockwise"></i> Buka Kembali</button>`
                : `<button type="button" class="btn btn--outline btn--sm" onclick="app.updateTicketStatus(${ticket.id}, 'close', 'admin')"><i class="ph ph-check-circle"></i> Tandai Selesai</button>`)
            : (ticket.status !== 'closed' ? `<button type="button" class="btn btn--outline btn--sm" onclick="app.updateTicketStatus(${ticket.id}, 'close', 'user')"><i class="ph ph-check-circle"></i> Masalah Selesai</button>` : '');
        const residentInfo = viewer === 'admin'
            ? `<p class="text-muted helpdesk-thread__sub"><i class="ph ph-user"></i> ${this.escape(ticket.residentName)} · NIK ${this.escape(ticket.nik)}${ticket.residentPhone ? ` · ${this.escape(ticket.residentPhone)}` : ''}</p>`
            : '';
        const messages = ticket.messages.map(message => {
            const mine = message.sender === viewer;
            const name = message.sender === 'admin' ? `${this.escape(message.senderName)} (Petugas)` : this.escape(message.senderName);
            return `<div class="chat-bubble ${mine ? 'chat-bubble--mine' : ''} chat-bubble--${message.sender}"><div class="chat-bubble__name">${name}</div><div class="chat-bubble__body">${this.escape(message.body)}</div><div class="chat-bubble__time">${this.escape(this.formatTime(message.createdAt))}</div></div>`;
        }).join('');
        const placeholder = ticket.status === 'closed'
            ? (viewer === 'admin' ? 'Tiket selesai. Balasan akan membuka ulang percakapan.' : 'Tiket selesai. Kirim pesan untuk membuka kembali.')
            : 'Tulis balasan...';
        container.innerHTML = `
            <div class="helpdesk-thread__header">
                <div><h5>#${ticket.id} ${this.escape(ticket.subject)}</h5>${residentInfo}<p class="text-muted helpdesk-thread__sub"><i class="ph ph-tag"></i> ${this.escape(ticket.category)} · dibuat ${this.escape(this.formatTime(ticket.createdAt))}</p></div>
                <div class="helpdesk-thread__actions"><span class="pill ${status.cls}">${status.label}</span>${actions}</div>
            </div>
            <div class="helpdesk-thread__messages">${messages}</div>
            <form class="helpdesk-reply" onsubmit="app.sendTicketReply(event, ${ticket.id}, '${viewer}')">
                <textarea class="form__input form__input--plain" rows="2" maxlength="2000" placeholder="${placeholder}" required>${this.escape(draft)}</textarea>
                <button type="submit" class="btn btn--primary"><i class="ph ph-paper-plane-tilt"></i> Kirim</button>
            </form>`;
        const list = container.querySelector('.helpdesk-thread__messages');
        list.scrollTop = list.scrollHeight;
    },

    helpdeskEndpoint(viewer, ticketId = '') {
        const base = viewer === 'admin' ? '/api/helpdesk/admin' : `/api/helpdesk/user/${encodeURIComponent(this.data.currentUser.nik)}`;
        return ticketId ? `${base}/${ticketId}` : base;
    },

    helpdeskRequest(viewer, ticketId, options) {
        return viewer === 'admin' ? this.api(this.helpdeskEndpoint(viewer, ticketId), options) : this.residentApi(this.helpdeskEndpoint(viewer, ticketId), options);
    },

    replaceTicket(ticket) {
        const index = this.data.helpdeskTickets.findIndex(item => item.id === ticket.id);
        if(index < 0) this.data.helpdeskTickets.unshift(ticket);
        else this.data.helpdeskTickets[index] = ticket;
        this.data.helpdeskTickets.sort((a, b) => b.updatedAt - a.updatedAt);
    },

    renderHelpdesk(viewer) {
        if(viewer === 'admin') return this.renderAdminHelpdesk();
        const ticket = this.data.helpdeskTickets.find(item => item.id === this.activeTicketId);
        this.renderTicketList(document.getElementById('helpdesk-ticket-list'), this.data.helpdeskTickets, 'user', 'Belum ada tiket. Klik "Buat Tiket" untuk menghubungi petugas.');
        this.renderTicketThread(document.getElementById('helpdesk-thread'), ticket, 'user');
    },

    async selectTicket(id, viewer) {
        this.activeTicketId = id;
        const ticket = this.data.helpdeskTickets.find(item => item.id === id);
        this.renderHelpdesk(viewer);
        document.getElementById(viewer === 'admin' ? 'admin-helpdesk-thread' : 'helpdesk-thread')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        if(ticket?.unread) {
            try {
                const result = await this.helpdeskRequest(viewer, id, { method: 'PATCH', body: JSON.stringify({ action: 'read' }) });
                this.replaceTicket(result.ticket);
                this.renderHelpdesk(viewer);
                if(viewer === 'admin') this.updateAdminHelpdeskBadge();
            } catch(error) { /* status baca tidak kritis */ }
        }
    },

    async sendTicketReply(event, id, viewer) {
        event.preventDefault();
        const form = event.target;
        const textarea = form.querySelector('textarea');
        const message = textarea.value.trim();
        if(!message) return;
        const button = form.querySelector('button');
        button.disabled = true;
        const payload = viewer === 'admin'
            ? { message, adminId: this.data.currentAdmin?.idKerja || '', adminName: this.data.currentAdmin?.name || 'Petugas Adminduk' }
            : { message };
        try {
            const result = await this.helpdeskRequest(viewer, id, { method: 'POST', body: JSON.stringify(payload) });
            textarea.value = '';
            this.replaceTicket(result.ticket);
            this.renderHelpdesk(viewer);
            if(viewer === 'user') this.recordResidentActivity('Helpdesk', `Membalas tiket #${id}.`);
        } catch(error) {
            alert(error.message);
        } finally {
            button.disabled = false;
        }
    },

    async updateTicketStatus(id, action, viewer) {
        if(action === 'close' && !confirm('Tandai tiket ini sebagai selesai?')) return;
        try {
            const result = await this.helpdeskRequest(viewer, id, { method: 'PATCH', body: JSON.stringify({ action }) });
            this.replaceTicket(result.ticket);
            this.renderHelpdesk(viewer);
            if(viewer === 'admin') this.updateAdminHelpdeskBadge();
        } catch(error) {
            alert(error.message);
        }
    },

    // Helpdesk di laman penduduk.
    async initUserHelpdesk() {
        document.getElementById('helpdesk-new-form').addEventListener('submit', event => this.createTicket(event));
        await this.loadUserHelpdesk();
        const presetCategory = new URLSearchParams(window.location.search).get('kategori');
        if(presetCategory) this.openNewTicket(presetCategory);
        this.helpdeskRefreshInterval = setInterval(() => this.loadUserHelpdesk(), 10000);
    },

    async loadUserHelpdesk() {
        try {
            const result = await this.residentApi(this.helpdeskEndpoint('user'));
            this.data.helpdeskTickets = result.tickets || [];
            if(!this.data.helpdeskCategories.length) {
                this.data.helpdeskCategories = result.categories || [];
                document.getElementById('helpdesk-category').innerHTML = this.data.helpdeskCategories.map(category => `<option>${this.escape(category)}</option>`).join('');
            }
            this.renderHelpdesk('user');
        } catch(error) {
            if(!this.data.helpdeskTickets.length) document.getElementById('helpdesk-ticket-list').innerHTML = `<div class="alert alert--warning"><i class="ph ph-warning"></i><span>${this.escape(error.message)}</span></div>`;
        }
    },

    openNewTicket(category) {
        const form = document.getElementById('helpdesk-new-form');
        form.style.display = 'block';
        if(category && this.data.helpdeskCategories.includes(category)) document.getElementById('helpdesk-category').value = category;
        document.getElementById('helpdesk-subject').focus();
    },

    closeNewTicket() {
        const form = document.getElementById('helpdesk-new-form');
        form.reset();
        form.style.display = 'none';
    },

    async createTicket(event) {
        event.preventDefault();
        const button = event.submitter;
        if(button) button.disabled = true;
        try {
            const result = await this.residentApi(this.helpdeskEndpoint('user'), {
                method: 'POST',
                body: JSON.stringify({
                    category: document.getElementById('helpdesk-category').value,
                    subject: document.getElementById('helpdesk-subject').value.trim(),
                    message: document.getElementById('helpdesk-message').value.trim()
                })
            });
            this.replaceTicket(result.ticket);
            this.activeTicketId = result.ticket.id;
            this.closeNewTicket();
            this.renderHelpdesk('user');
            this.showToast('Tiket terkirim', `Tiket #${result.ticket.id} diteruskan ke petugas Adminduk.`, 'ph-paper-plane-tilt');
            this.recordResidentActivity('Helpdesk', `Membuat tiket #${result.ticket.id}: ${result.ticket.subject}.`);
        } catch(error) {
            alert(error.message);
        } finally {
            if(button) button.disabled = false;
        }
    },

    // ==========================================================================
    // LAMAN PETUGAS: Helpdesk & Informasi Akun Petugas
    // ==========================================================================
    initAdminExtras() {
        try {
            this.data.currentAdmin = JSON.parse(sessionStorage.getItem('siaga_current_admin') || 'null');
        } catch(error) {
            this.data.currentAdmin = null;
        }
        if(this.data.currentAdmin) {
            document.getElementById('admin-name-display').textContent = this.data.currentAdmin.name;
            document.getElementById('admin-avatar-initial').textContent = (this.data.currentAdmin.name || 'P').charAt(0).toUpperCase();
        }
        this.loadAdminHelpdesk();
        this.adminHelpdeskInterval = setInterval(() => this.loadAdminHelpdesk(), 15000);
    },

    async loadAdminHelpdesk() {
        try {
            const result = await this.api(this.helpdeskEndpoint('admin'));
            this.data.helpdeskTickets = result.tickets || [];
            this.updateAdminHelpdeskBadge();
            if(document.getElementById('admin-panel-helpdesk')?.classList.contains('panel--active')) this.renderAdminHelpdesk();
        } catch(error) {
            const list = document.getElementById('admin-helpdesk-list');
            if(list && !this.data.helpdeskTickets.length) list.innerHTML = `<div class="alert alert--warning"><i class="ph ph-warning"></i><span>${this.escape(error.message)}</span></div>`;
        }
    },

    updateAdminHelpdeskBadge() {
        const badge = document.getElementById('admin-helpdesk-badge');
        if(!badge) return;
        const pending = this.data.helpdeskTickets.filter(ticket => ticket.status === 'open').length;
        badge.textContent = pending;
        badge.style.display = pending ? 'inline-flex' : 'none';
        badge.title = `${pending} tiket menunggu petugas`;
    },

    renderAdminHelpdesk() {
        const list = document.getElementById('admin-helpdesk-list');
        if(!list) return;
        const filter = document.getElementById('admin-helpdesk-filter').value;
        const tickets = this.data.helpdeskTickets.filter(ticket => filter === 'all' || ticket.status === filter);
        this.renderTicketList(list, tickets, 'admin', filter === 'all' ? 'Belum ada tiket dari penduduk.' : 'Tidak ada tiket dengan status ini.');
        this.renderTicketThread(document.getElementById('admin-helpdesk-thread'), this.data.helpdeskTickets.find(ticket => ticket.id === this.activeTicketId), 'admin');
    },

    renderAdminAccount() {
        const container = document.getElementById('admin-account-info');
        if(!container) return;
        const admin = this.data.currentAdmin;
        if(!admin) {
            container.innerHTML = `<div class="alert alert--warning"><i class="ph ph-warning-circle"></i><span>Sesi petugas tidak ditemukan. Silakan masuk kembali melalui halaman login petugas untuk melihat informasi akun.</span></div><div class="form-actions mt-4"><button class="btn btn--primary" onclick="window.location.href='../index.html'"><i class="ph ph-sign-in"></i> Masuk Kembali</button></div>`;
            return;
        }
        const rows = [
            ['ph-identification-badge', 'ID Tempat Kerja', admin.idKerja],
            ['ph-hash', 'NIP', admin.nip],
            ['ph-briefcase', 'Jabatan', admin.jabatan],
            ['ph-shield-star', 'Peran Sistem', admin.role],
            ['ph-buildings', 'Unit Kerja', admin.unitKerja],
            ['ph-map-pin', 'Lokasi Tugas', admin.wilayah],
            ['ph-envelope-simple', 'Email Dinas', admin.email],
            ['ph-phone', 'No. Telepon', admin.phone],
            ['ph-clock', 'Login Sejak', admin.loginAt ? this.formatTime(admin.loginAt) : '-']
        ];
        container.innerHTML = `
            <div class="admin-account__header">
                <div class="avatar admin-account__avatar">${this.escape((admin.name || 'P').charAt(0).toUpperCase())}</div>
                <div>
                    <h3>${this.escape(admin.name)}</h3>
                    <p class="text-muted">${this.escape(admin.jabatan || 'Petugas Adminduk')}</p>
                    <span class="pill pill--success"><i class="ph ph-circle" style="font-size:0.6rem"></i> Sedang Login</span>
                </div>
            </div>
            <div class="admin-account__grid">
                ${rows.map(([icon, label, value]) => `<div class="admin-account__item"><i class="ph ${icon}"></i><div><span>${label}</span><strong>${this.escape(value || '-')}</strong></div></div>`).join('')}
            </div>
            <h5 class="admin-account__subtitle">Hak Akses</h5>
            <div class="admin-account__access">${(admin.hakAkses || []).map(item => `<span class="pill pill--info"><i class="ph ph-check"></i> ${this.escape(item)}</span>`).join('')}</div>
            <div class="admin-account__stats">
                <div><strong>${this.data.users.length}</strong><span>Penduduk terdaftar</span></div>
                <div><strong>${this.data.helpdeskTickets.filter(ticket => ticket.status === 'open').length}</strong><span>Tiket menunggu</span></div>
                <div><strong>${this.data.helpdeskTickets.length}</strong><span>Total tiket Helpdesk</span></div>
            </div>`;
    },

    // ==========================================================================
    // SESI PENDUDUK 3 JAM: hitung mundur, peringatan, dan logout otomatis
    // ==========================================================================
    startSessionTimer() {
        const user = this.data.currentUser;
        if(!user?.tokenExpiresAt) return;
        const header = document.querySelector('.main-header__user');
        if(header && !document.getElementById('session-timer')) {
            header.insertAdjacentHTML('afterbegin', '<div id="session-timer" class="session-timer" title="Sisa masa berlaku Token Akses (3 jam sejak klaim)"><i class="ph ph-timer"></i><span id="session-timer-text">--:--:--</span></div>');
        }
        const warned = new Set();
        const tick = () => {
            const remaining = user.tokenExpiresAt - Date.now();
            const text = document.getElementById('session-timer-text');
            const box = document.getElementById('session-timer');
            if(remaining <= 0) {
                clearInterval(this.sessionTimerInterval);
                this.expireSession();
                return;
            }
            const total = Math.floor(remaining / 1000);
            if(text) text.textContent = `${String(Math.floor(total / 3600)).padStart(2, '0')}:${String(Math.floor(total % 3600 / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
            if(box) {
                box.classList.toggle('session-timer--warning', remaining <= 30 * 60000 && remaining > 5 * 60000);
                box.classList.toggle('session-timer--danger', remaining <= 5 * 60000);
            }
            [[30, 'Sesi berakhir dalam 30 menit'], [10, 'Sesi berakhir dalam 10 menit'], [1, 'Sesi berakhir dalam 1 menit']].forEach(([minutes, title]) => {
                if(remaining <= minutes * 60000 && !warned.has(minutes)) {
                    warned.add(minutes);
                    this.showToast(title, 'Token Akses berlaku 3 jam. Setelah habis Anda otomatis keluar dan perlu klaim ulang token.', 'ph-clock-countdown');
                }
            });
        };
        // Saat halaman dibuka dengan sisa waktu sedikit, peringatan yang sudah lewat tidak ditampilkan ulang.
        const initialRemaining = user.tokenExpiresAt - Date.now();
        [30, 10, 1].forEach(minutes => { if(initialRemaining <= (minutes - 1) * 60000) warned.add(minutes); });
        tick();
        clearInterval(this.sessionTimerInterval);
        this.sessionTimerInterval = setInterval(tick, 1000);
        // Saat tab kembali aktif, periksa juga ke server (token mungkin sudah diganti atau kedaluwarsa).
        document.addEventListener('visibilitychange', async () => {
            if(document.visibilityState !== 'visible' || !this.data.currentUser) return;
            const fresh = await this.loadResident(this.data.currentUser.nik);
            if(fresh && (fresh.tokenStatus !== 'active' || fresh.token !== this.data.currentUser.token)) this.expireSession();
        });
    },

    expireSession() {
        if(this.sessionExpired) return;
        this.sessionExpired = true;
        ['usersRefreshInterval', 'securityRefreshInterval', 'helpdeskRefreshInterval', 'sessionTimerInterval'].forEach(key => clearInterval(this[key]));
        sessionStorage.removeItem('siaga_current_user');
        document.body.insertAdjacentHTML('beforeend', `<div id="session-expired-modal" class="modal-overlay modal-overlay--open"><div class="modal-content"><div class="session-expired__icon"><i class="ph ph-clock-countdown"></i></div><h3>Sesi Berakhir</h3><p class="text-muted">Token Akses Anda sudah melewati batas 3 jam sehingga Anda otomatis keluar. Silakan klaim ulang token untuk masuk kembali.</p><div class="form-actions mt-4"><button class="btn btn--primary btn--full" onclick="window.location.href='../index.html?token=expired'"><i class="ph ph-key"></i> Klaim Ulang Token</button></div></div></div>`);
        setTimeout(() => { window.location.href = '../index.html?token=expired'; }, 8000);
    },

    // ==========================================================================
    // SECURE SHARE: pilihan "Bagikan kepada" per kategori penerima
    // ==========================================================================
    shareRecipientGroups: [
        { id: 'pemerintah', title: 'Instansi Pemerintah', icon: 'ph-bank', desc: 'Layanan publik & administrasi', items: [
            { name: 'Disdukcapil', detail: 'Administrasi kependudukan' },
            { name: 'Kantor Kelurahan / Desa', detail: 'Surat pengantar & domisili' },
            { name: 'Kantor Kecamatan', detail: 'Layanan kecamatan' },
            { name: 'Kepolisian (SKCK)', detail: 'Pengurusan SKCK' }
        ] },
        { id: 'pendidikan', title: 'Pendidikan', icon: 'ph-graduation-cap', desc: 'Sekolah, kampus & beasiswa', items: [
            { name: 'Dinas Pendidikan', detail: 'PPDB & administrasi sekolah' },
            { name: 'Sekolah', detail: 'SD / SMP / SMA / SMK' },
            { name: 'Perguruan Tinggi', detail: 'Pendaftaran mahasiswa' },
            { name: 'Penyelenggara Beasiswa', detail: 'Seleksi beasiswa' }
        ] },
        { id: 'kesehatan', title: 'Kesehatan & Sosial', icon: 'ph-first-aid-kit', desc: 'Jaminan kesehatan & bansos', items: [
            { name: 'BPJS Kesehatan', detail: 'Kepesertaan JKN' },
            { name: 'Rumah Sakit / Puskesmas', detail: 'Pendaftaran pasien' },
            { name: 'Dinas Sosial', detail: 'Bantuan sosial' },
            { name: 'BPJS Ketenagakerjaan', detail: 'Jaminan kerja' }
        ] },
        { id: 'keuangan', title: 'Keuangan & Swasta', icon: 'ph-briefcase', desc: 'Perbankan & dunia kerja', items: [
            { name: 'Bank', detail: 'Pembukaan rekening / kredit' },
            { name: 'Perusahaan / HRD', detail: 'Lamaran kerja' },
            { name: 'Asuransi', detail: 'Polis & klaim' },
            { name: 'Operator Seluler', detail: 'Registrasi kartu' }
        ] }
    ],

    initShareRecipients() {
        const grid = document.getElementById('share-recipient-grid');
        if(!grid) return;
        grid.innerHTML = this.shareRecipientGroups.map(group => `
            <div class="recipient-column">
                <div class="recipient-column__head"><i class="ph ${group.icon}"></i><div><strong>${this.escape(group.title)}</strong><span>${this.escape(group.desc)}</span></div></div>
                <div class="recipient-column__list">
                    ${group.items.map(item => `<button type="button" class="recipient-option" data-category="${this.escape(group.title)}" data-name="${this.escape(item.name)}" onclick="app.selectShareRecipient(this)"><span class="recipient-option__radio"></span><span class="recipient-option__text"><strong>${this.escape(item.name)}</strong><small>${this.escape(item.detail)}</small></span></button>`).join('')}
                </div>
            </div>`).join('') + `
            <div class="recipient-column recipient-column--other">
                <div class="recipient-column__head"><i class="ph ph-user-circle-plus"></i><div><strong>Lainnya / Perorangan</strong><span>Penerima tidak ada di daftar</span></div></div>
                <div class="recipient-column__list">
                    <label class="form__group" style="margin:0"><span class="recipient-label">Nama penerima / instansi</span><input type="text" id="share-target-custom" class="form__input form__input--plain" maxlength="120" placeholder="Contoh: PT Maju Jaya, Bpk. Andi"></label>
                </div>
            </div>`;
        document.getElementById('share-target-custom').addEventListener('input', event => {
            const value = event.target.value.trim();
            grid.querySelectorAll('.recipient-option').forEach(option => option.classList.remove('recipient-option--selected'));
            this.setShareRecipient(value, value ? 'Lainnya / Perorangan' : '');
        });
        const search = document.getElementById('share-recipient-search');
        if(search) search.addEventListener('input', () => {
            const query = search.value.trim().toLowerCase();
            grid.querySelectorAll('.recipient-option').forEach(option => {
                option.style.display = !query || option.textContent.toLowerCase().includes(query) || option.dataset.category.toLowerCase().includes(query) ? '' : 'none';
            });
        });
        const purposeSelect = document.getElementById('share-purpose');
        if(purposeSelect) purposeSelect.addEventListener('change', () => {
            document.getElementById('share-purpose-custom').style.display = purposeSelect.value === 'Lainnya' ? 'block' : 'none';
        });
    },

    selectShareRecipient(button) {
        document.querySelectorAll('.recipient-option').forEach(option => option.classList.remove('recipient-option--selected'));
        button.classList.add('recipient-option--selected');
        const custom = document.getElementById('share-target-custom');
        if(custom) custom.value = '';
        this.setShareRecipient(button.dataset.name, button.dataset.category);
    },

    setShareRecipient(name, category) {
        document.getElementById('share-target').value = name;
        this.data.shareState.target = name;
        this.data.shareState.category = category;
        const summary = document.getElementById('share-recipient-summary');
        if(summary) {
            summary.style.display = name ? 'flex' : 'none';
            summary.innerHTML = name ? `<i class="ph ph-check-circle"></i><span>Dibagikan kepada <strong>${this.escape(name)}</strong> · ${this.escape(category)}</span>` : '';
        }
    },

    // ==========================================================================
    // LAMAN PETUGAS: preview dokumen sebelum data disimpan
    // ==========================================================================
    bindAdminDocumentPreviews() {
        this.previewUrls = {};
        ['add', 'edit'].forEach(prefix => this.documentTypes.forEach(type => {
            const input = document.getElementById(`${prefix}-doc-${type.id}`);
            if(!input || input.dataset.previewBound) return;
            input.dataset.previewBound = 'true';
            input.insertAdjacentHTML('afterend', `<div class="upload-preview" id="${input.id}-preview" style="display:none"></div>`);
            input.addEventListener('change', () => this.renderUploadPreview(input, type));
        }));
        ['admin-add-user-form', 'edit-user-form'].forEach(id => {
            const form = document.getElementById(id);
            if(form) form.addEventListener('reset', () => setTimeout(() => form.querySelectorAll('input[type="file"]').forEach(input => {
                const type = this.documentTypes.find(item => input.id.endsWith(`-doc-${item.id}`));
                if(type) this.renderUploadPreview(input, type);
            })));
        });
        if(!document.getElementById('doc-preview-modal')) {
            document.body.insertAdjacentHTML('beforeend', `<div id="doc-preview-modal" class="modal-overlay" onclick="if(event.target===this)app.closeDocPreview()"><div class="modal-content doc-preview-modal"><div class="doc-preview-modal__head"><div><h3 id="doc-preview-title">Preview Dokumen</h3><p class="text-muted" id="doc-preview-meta"></p></div><button type="button" class="btn-icon" onclick="app.closeDocPreview()" aria-label="Tutup preview"><i class="ph ph-x"></i></button></div><div class="doc-preview-modal__body" id="doc-preview-body"></div><div class="alert alert--info mt-3"><i class="ph ph-info"></i><span>Ini pratinjau sebelum disimpan. Periksa kembali isi dokumen, lalu klik Simpan untuk mengunggah.</span></div><div class="form-actions row mt-3"><button type="button" class="btn btn--outline" id="doc-preview-remove"><i class="ph ph-trash"></i> Hapus File Ini</button><button type="button" class="btn btn--primary" onclick="app.closeDocPreview()"><i class="ph ph-check"></i> Dokumen Sudah Sesuai</button></div></div></div>`);
        }
    },

    renderUploadPreview(input, type) {
        const box = document.getElementById(`${input.id}-preview`);
        if(!box) return;
        if(this.previewUrls[input.id]) URL.revokeObjectURL(this.previewUrls[input.id]);
        delete this.previewUrls[input.id];
        const file = input.files && input.files[0];
        if(!file) { box.style.display = 'none'; box.innerHTML = ''; return; }
        const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
        const isPng = file.type === 'image/png';
        const problems = [];
        if(!isPdf && !isPng) problems.push('Format harus PNG atau PDF');
        if(file.size > 1024 * 1024) problems.push('Ukuran melebihi 1 MB');
        const url = URL.createObjectURL(file);
        this.previewUrls[input.id] = url;
        const size = file.size >= 1024 * 1024 ? `${(file.size / 1048576).toFixed(2)} MB` : `${Math.max(1, Math.round(file.size / 1024))} KB`;
        const thumb = isPng ? `<img src="${url}" alt="">` : `<i class="ph ${isPdf ? 'ph-file-pdf' : 'ph-file-x'}"></i>`;
        box.style.display = 'flex';
        box.className = `upload-preview ${problems.length ? 'upload-preview--error' : ''}`;
        box.innerHTML = `<div class="upload-preview__thumb">${thumb}</div><div class="upload-preview__info"><strong>${this.escape(file.name)}</strong><span>${isPdf ? 'PDF' : isPng ? 'PNG' : this.escape(file.type || 'Tidak dikenal')} · ${size}</span>${problems.length ? `<span class="upload-preview__error"><i class="ph ph-warning-circle"></i> ${this.escape(problems.join(' · '))}</span>` : '<span class="upload-preview__ok"><i class="ph ph-check-circle"></i> Siap diunggah</span>'}</div>${(isPdf || isPng) ? `<button type="button" class="btn btn--outline btn--sm" onclick="app.openDocPreview('${input.id}', '${type.id}')"><i class="ph ph-eye"></i> Preview</button>` : ''}<button type="button" class="btn-icon" title="Batalkan file" onclick="app.clearUpload('${input.id}', '${type.id}')"><i class="ph ph-x"></i></button>`;
    },

    openDocPreview(inputId, typeId) {
        const input = document.getElementById(inputId);
        const file = input?.files?.[0];
        const url = this.previewUrls?.[inputId];
        const type = this.documentTypes.find(item => item.id === typeId);
        if(!file || !url) return;
        const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
        document.getElementById('doc-preview-title').textContent = `Preview ${type?.name || 'Dokumen'}`;
        document.getElementById('doc-preview-meta').textContent = `${file.name} · ${(file.size / 1024).toFixed(0)} KB`;
        document.getElementById('doc-preview-body').innerHTML = isPdf
            ? `<iframe title="Preview ${this.escape(file.name)}" src="${url}"></iframe>`
            : `<img src="${url}" alt="Preview ${this.escape(file.name)}">`;
        document.getElementById('doc-preview-remove').onclick = () => { this.clearUpload(inputId, typeId); this.closeDocPreview(); };
        document.getElementById('doc-preview-modal').classList.add('modal-overlay--open');
    },

    closeDocPreview() {
        document.getElementById('doc-preview-modal')?.classList.remove('modal-overlay--open');
        const body = document.getElementById('doc-preview-body');
        if(body) body.innerHTML = '';
    },

    clearUpload(inputId, typeId) {
        const input = document.getElementById(inputId);
        const type = this.documentTypes.find(item => item.id === typeId);
        if(!input || !type) return;
        input.value = '';
        this.renderUploadPreview(input, type);
    },

    setupToastContainer() {
        if(!document.getElementById('toast-container')) document.body.insertAdjacentHTML('beforeend', '<div id="toast-container" class="toast-container"></div>');
    },

    startAccessDetector() {
        setTimeout(() => this.showToast('Peringatan Akses', 'Instansi Pemerintah X sedang membaca dokumen Anda.', 'ph-warning'), 15000);
    },

    showToast(title, message, iconClass, { email = true } = {}) {
        if(email) this.sendNotificationEmail(title, message, iconClass);
        const container = document.getElementById('toast-container');
        if(!container) return;
        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.innerHTML = `<i class="ph ${iconClass}"></i><div><strong>${title}</strong><p style="font-size:0.8rem;margin-top:0.25rem">${message}</p></div>`;
        container.appendChild(toast);
        setTimeout(() => toast.remove(), 5000);
    },

    // Setiap notifikasi yang muncul di aplikasi juga dikirim ke email penduduk lewat Netlify Function
    // (/api/notify). Kredensial email tetap di server; notifikasi identik dalam 10 menit tidak dikirim ulang.
    sendNotificationEmail(title, message, iconClass = '') {
        const user = this.data.currentUser;
        if(!user?.nik || !user.token) return;
        const text = String(message || '').replace(/<[^>]*>/g, '').trim();
        const key = `siaga_notif_email:${user.nik}:${title}:${text}`;
        try {
            const last = Number(localStorage.getItem(key) || 0);
            if(Date.now() - last < 10 * 60000) return;
            localStorage.setItem(key, String(Date.now()));
        } catch(error) { /* localStorage tidak tersedia: tetap kirim */ }
        const tone = /warning|clock|shield|lock/.test(iconClass) ? 'warning' : /check/.test(iconClass) ? 'success' : 'info';
        fetch(`/api/notify/${encodeURIComponent(user.nik)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...this.residentHeaders() },
            body: JSON.stringify({ title, message: text, tone, page: document.title }),
            keepalive: true
        }).catch(() => { /* Email gagal tidak mengganggu tampilan notifikasi */ });
    }
};

document.addEventListener('DOMContentLoaded', () => app.init());