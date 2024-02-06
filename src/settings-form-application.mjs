import {get_guild, getRequestOptions, handle_json_response, Logger} from "./util.mjs"
import {
    AUTH,
    DAYS_OF_WEEK,
    GUILD_NAME,
    ID_MAP,
    MODULE_ID,
    ORONDER_BASE_URL,
    TIMEZONES,
    VALID_CONFIG
} from "./constants.mjs"
import {full_sync} from "./sync.mjs"
import {open_socket_with_oronder} from "./module.mjs"

export class OronderSettingsFormApplication extends FormApplication {

    constructor(object = {}, options = {}) {
        const id_map = game.settings.get(MODULE_ID, ID_MAP)
        foundry.utils.mergeObject(object, {
            guild_name: game.settings.get(MODULE_ID, GUILD_NAME),
            guild: undefined,
            timezones: TIMEZONES,
            days_of_week: DAYS_OF_WEEK,
            auth: game.settings.get(MODULE_ID, AUTH),
            valid_config: game.settings.get(MODULE_ID, VALID_CONFIG),
            fetch_button_icon: "fa-solid fa-rotate",
            fetch_button_msg: game.i18n.localize("oronder.Fetch-Discord-User-Ids"),
            fetch_sync_disabled: false,
            full_sync_button_icon: "fa-solid fa-users",
            full_sync_button_msg: game.i18n.localize("oronder.Full-Sync"),
            full_sync_disabled: false,
            players: game.users.filter(user => user.role < 3).map(user => ({
                foundry_name: user.name,
                foundry_id: user.id,
                discord_id: id_map[user.id] ?? ''
            }))
        })
        super(object, options)
    }

    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: "oronder-options",
            template: `modules/${MODULE_ID}/templates/settings-form-application.hbs`,
            width: 580,
            resizable: true
        })
    }


    /** @override */
    get title() {
        return game.i18n.localize("oronder.Oronder-Bot-Config")
    }

    /** @override */
    async getData(options = {}) {
        Logger.info('getData()')
        if (this.object.auth) {
            this.object.guild = await get_guild(this.object.auth)
        }
        return this.object
    }

    /** @override */
    activateListeners(html) {
        super.activateListeners(html)
        html.find(".control").on("click", this._onClickControl.bind(this))
    }

    _onClickControl(event) {
        switch (event.currentTarget.dataset.action) {
            case "fetch":
                return this._fetch_discord_ids()
            case "sync-all":
                return this._full_sync()

        }
    }

    /** @override */
    //Save Changes
    async _updateObject(event, formData) {
        this.object.auth = this.form.elements.auth.value

        const id_map = {}
        const queryParams = new URLSearchParams()
        this.object.players.forEach(p => {
            p.discord_id = this.form.elements[p.foundry_id].value
            if (p.discord_id) {
                queryParams.append('i', p.discord_id)
                id_map[p.foundry_id] = p.discord_id
            }
        })
        const requestOptions = getRequestOptions(this.object.auth)
        let valid_config = false
        await fetch(`${ORONDER_BASE_URL}/validate_discord_ids?${queryParams}`, requestOptions)
            .then(response => {
                this.throw_on_401(response);
                return handle_json_response(response)
            })
            .then(invalid_discord_ids => {
                const invalid_player_names = invalid_discord_ids.map(invalid_discord_id => {
                    return this.object.players.find(p => p.discord_id === invalid_discord_id).foundry_name
                })

                if (invalid_player_names.length > 1) {
                    invalid_player_names.forEach(name => Logger.error(
                        `${name} ${game.i18n.localize("oronder.Could-Not-Be-Found")}`
                    ))
                } else {
                    valid_config = true
                }
            })
            .catch(Logger.error)

        if (!this.object.guild_name && this.object.auth) {
            const guild = await get_guild(this.object.auth)
            this.object.guild_name = guild?.name ?? ''
        }

        let updated = false

        if (game.settings.get(MODULE_ID, AUTH) !== this.object.auth) {
            game.settings.set(MODULE_ID, AUTH, this.object.auth)
            updated = true
        }
        game.settings.set(MODULE_ID, GUILD_NAME, this.object.guild_name)
        game.settings.set(MODULE_ID, VALID_CONFIG, valid_config)
        game.settings.set(MODULE_ID, ID_MAP, id_map)

        open_socket_with_oronder(updated)

        this.render()
    }

    throw_on_401(response) {
        if (response.status === 401) {
            this.object.guild_name = ''
            this.object.auth = ''
            throw new Error(game.i18n.localize("oronder.Invalid-Auth"))
        }
    }

    async _full_sync() {
        this.object.full_sync_button_icon = 'fa-solid fa-spinner fa-spin'
        this.object.full_sync_sync_disabled = true
        this.render()

        await full_sync().catch(Logger.error)

        this.object.full_sync_button_icon = "fa-solid fa-users"
        this.object.full_sync_sync_disabled = false
        this.render()
    }

    async _fetch_discord_ids() {
        this.object.auth = this.form.elements.auth.value
        this.object.players.forEach(p =>
            p.discord_id = this.form.elements[p.foundry_id].value
        )

        const players_without_discord_ids = this.object.players.filter(p =>
            !this.form.elements[p.foundry_id].value
        )
        let err = false

        if (!this.object.auth) {
            err = true
            Logger.error(game.i18n.localize("oronder.Auth-Token-Empty"))
        }
        if (!players_without_discord_ids.length) {
            err = true
            Logger.warn(game.i18n.localize("oronder.No-Players-To-Sync"))
        }

        if (err) {
            this.render()
            return
        }

        this.object.fetch_button_icon = 'fa-solid fa-spinner fa-spin'
        this.object.fetch_sync_disabled = true
        this.render()

        const queryParams = new URLSearchParams()
        players_without_discord_ids.forEach(p =>
            queryParams.append('p', p.foundry_name)
        )
        const requestOptions = this._getRequestOptions(this.object.auth)

        const p1 = get_guild(this.object.auth)
            .then(guild => this.object.guild_name = guild?.name ?? '')

        const p2 = fetch(`${ORONDER_BASE_URL}/discord_id?${queryParams}`, requestOptions)
            .then(response => {
                this.throw_on_401(response);
                return handle_json_response(response)
            })
            .then(result => {
                for (const [foundry_name, discord_user_id] of Object.entries(result)) {
                    this.object.players.find(p => p.foundry_name === foundry_name).discord_id = discord_user_id
                }
            })
            .catch(Logger.error)

        await Promise.all([p1, p2])

        this.object.fetch_button_icon = "fa-solid fa-rotate"
        this.object.fetch_sync_disabled = false
        this.render()
    }
}