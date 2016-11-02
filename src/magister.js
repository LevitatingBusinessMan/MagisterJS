'use strict'

import _ from 'lodash'
import fetch from 'node-fetch'

import AbsenceInfo from './absenceInfo'
import Appointment from './appointment'
import AuthError from './authError'
import Course from './course'
import Http from './http'
import Message from './message'
import MessageFolder from './messageFolder'
import Person from './person'
import Privileges from './privileges'
import ProfileInfo from './profileInfo'
import School from './school'
import * as util from './util'

import AddressInfo from './addressInfo'
import ProfileSettings from './profileSettings'

// TODO: add nice warnings when trying to do stuff while not logged in yet

/**
 * Class to communicate with Magister.
 * @private
 */
class Magister {
	/**
	 * @param {Object} options
	 * @param {School} school
	 * @param {Http} http
	 */
	constructor(options, school, http) {
		this._options = options
		this.school = _.extend(new School({}), school)
		this.http = http
	}

	/**
	 * @param {Date} from Time is ignored.
	 * @param {Date} [to=from] Time is ignored
	 * @param {Object} [options={}]
	 * 	@param {Boolean} [options.fillPersons=false]
	 * 	@param {Boolean} [options.fetchAbsences=true]
	 * 	@param {Boolean} [options.ignoreAbsenceErrors=true]
	 * @return {Promise<Appointment[]>}
	 */
	appointments() {
		// extract options
		const {
			fillPersons = false,
			fetchAbsences = true,
			ignoreAbsenceErrors = true,
		} = _.find(arguments, _.isPlainObject) || {}

		// extract dates
		let [ from, to ] = _(arguments).filter(_.isDate).sortBy().value()
		to = to || from

		const fromUrl = util.urlDateConvert(from)
		const toUrl = util.urlDateConvert(to)

		// fetch appointments
		const appointmentsUrl = `${this._personUrl}/afspraken?van=${fromUrl}&tot=${toUrl}`
		const appointmentsPromise = this._privileges.needs('afspraken', 'read')
		.then(() => this.http.get(appointmentsUrl))
		.then(res => res.json())
		.then(res => res.Items.map(a => new Appointment(this, a)))

		// fetch absences
		let absencesPromise = Promise.resolve([])
		if (fetchAbsences) {
			const absencesUrl = `${this._personUrl}/absenties?van=${fromUrl}&tot=${toUrl}`
			absencesPromise = this._privileges.needs('Absenties', 'read')
			.then(() => this.http.get(absencesUrl))
			.then(res => res.json())
			.then(res => res.Items.map(a => new AbsenceInfo(this, a)))

			if (ignoreAbsenceErrors) {
				absencesPromise = absencesPromise.catch(() => [])
			}
		}

		return Promise.all([ appointmentsPromise, absencesPromise ])
		.then(([ appointments, absences ]) => {
			for (const a of appointments) {
				a.absenceInfo = absences.find(i => i.appointment.id === a.id)
			}

			return _(appointments)
			.sortBy('start')
			.value()
		})
		.then(appointments => {
			if (!fillPersons) {
				return appointments
			}

			const promises = appointments.map(a => {
				return Promise.all(a.teachers.map(t => t.getFilled('teacher')))
				.then(teachers => a.teachers = teachers)
				.then(() => a)
			})
			return Promise.all(promises)
		})
	}

	/**
	 * @return {Promise<Course>}
	 */
	courses() {
		return this._privileges.needs('aanmeldingen', 'read')
		.then(() => this.http.get(`${this._personUrl}/aanmeldingen`))
		.then(res => res.json())
		.then(res => res.Items.map(c => new Course(this, c)))
		.then(items => _.sortBy(items, 'start'))
	}

	/**
	 * @param {Object} options
	 * 	@param {String} options.description The description of the appointment.
	 * 	@param {Date} options.start The start of the appointment, time is
	 * 	ignored when `options.fullDay` is set to true.
	 * 	@param {Date} options.end The end of the appointment, this is ignored
	 * 	when `options.fullDay` is set to true.
	 * 	@param {Boolean} [options.fullDay=false] When this is true,
	 * 	`options.end` is ignored and only `options.start` is used to set the
	 * 	begin and the end for the appointment.
	 * 	@param {String} [options.location] The location (classroom for example)
	 * 	for the appointment.
	 * 	@param {String} [options.content] Some arbitrary string you want to
	 * 	save.
	 * 	@param {Number} [options.type=1] The type of the appointment: 1 for
	 * 	personal or 16 for planning
	 */
	createAppointment(options) {
		const required = [ 'description', 'start', 'end' ]
		for (const key of required) {
			if (options[key] == null) {
				const err = new Error(`Not all required fields for \`options\` are given, required are: [ ${required.join(', ')} ]`)
				return Promise.reject(err)
			}
		}

		if (options.fullDay) {
			options.start = util.date(options.start)
			options.end = new Date(options.start.getTime()) + 1000*60*60*24
		}

		const payload = {
			Omschrijving: options.description,
			Start: options.start.toJSON(),
			Einde: options.end.toJSON(),

			Lokatie: options.location || '',
			Inhoud: (function () {
				const content = (options.content || '').trim()
				return content.length > 0 ? _.escape(content) : null
			})(),
			Type: options.type || 1,
			DuurtHeleDag: options.fullDay || false,

			// Static non-configurable stuff.
			InfoType: 0,
			WeergaveType: 1,
			Status: 2,
			HeeftBijlagen: false,
			Bijlagen: null,
			LesuurVan: null,
			LesuurTotMet: null,
			Aantekening: null,
			Afgerond: false,
			Vakken: null,
			Docenten: null,
			Links: null,
			Id: 0,
			Lokalen: null,
			Groepen: null,
			OpdrachtId: 0,
		}

		return this._privileges.needs('afspraken', 'create')
		.then(() => this.http.post(`${this._personUrl}/afspraken`, payload))
		.then(res => res.json())
		.then(res => {
			const appointment = new Appointment(this, payload)
			appointment._url = this.school.url + res.Url
			return appointment
		})
	}

	/**
	 * @return {Promise<MessageFolder[]>}
	 */
	messageFolders() {
		return this._privileges.needs('berichten', 'read')
		.then(() => this.http.get(`${this._personUrl}/berichten/mappen`))
		.then(res => res.json())
		.then(res => res.Items.map(m => new MessageFolder(this, m)))
	}

	/**
	 * @param {String} query
	 * @param {String} [type]
	 * @return {Promise<Person[]>}
	 */
	persons(query, type) {
		query = query != null ? query.trim() : ''

		if (query.length < 3) {
			return Promise.resolve([])
		} else if (type == null) {
			return Promise.all([
				this.persons(query, 'teacher'),
				this.persons(query, 'pupil'),
			]).then(([ teachers, pupils ]) => teachers.concat(pupils))
		}

		type = ({
			'teacher': 'Personeel',
			'pupil': 'Leerling',
			'project': 'Project',
		})[type] || 'Overig'
		query = query.replace(/ +/g, '+')

		const url = `${this._personUrl}/contactpersonen?contactPersoonType=${type}&q=${query}`

		return this._privileges.needs('contactpersonen', 'read')
		.then(() => this.http.get(url))
		.then(res => res.json())
		.then(res => res.Items.map(p => {
			p = new Person(this, p)
			p._filled = true
			return p
		}))
	}

	/**
	 * Logins to Magister.
	 * @param {Boolean} [forceNew=false]
	 * @return {Promise<String>} A promise that resolves when done logging in. With the current session ID as parameter.
	 */
	login(forceNew = false) {
		const setSessionId = sessionId => {
			const cookie = `SESSION_ID=${sessionId}; M6UserName=${this._options.username}`
			this.http._cookie = cookie
			return sessionId
		}

		const options = this._options
		const baseUrl = this.school.url.replace(/^https?/, 'https')
		const deleteUrl = `${baseUrl}/api/sessies/huidige`
		const postUrl = `${baseUrl}/api/sessies`

		let promise
		if (!forceNew && options.sessionId) {
			promise = Promise.resolve(options.sessionId)
		} else {
			// delete the current session
			promise = this.http.delete(deleteUrl)
			.then(r => {
				setSessionId(/[a-z\d-]+/.exec(r.headers.get('set-cookie'))[0])

				// create a new session
				return this.http.post(postUrl, {
					Gebruikersnaam: options.username,
					Wachtwoord: options.password,
					IngelogdBlijven: options.keepLoggedIn,
				})
			})
			.then(r => /[a-z\d-]+/.exec(r.headers.get('set-cookie'))[0])
			.catch(err => {
				throw _.includes([
					'Ongeldig account of verkeerde combinatie van gebruikersnaam en wachtwoord. Probeer het nog eens of neem contact op met de applicatiebeheerder van de school.',
					'Je gebruikersnaam en/of wachtwoord is niet correct.',
				], err.message) ?
				new AuthError(err.message) :
				err
			})
		}

		return promise
		.then(setSessionId)
		.then(sessionId => {
			return this.http.get(`${baseUrl}/api/account`)
			.then(res => res.json())
			.then(res => {
				const id = res.Persoon.Id

				this.profileInfo = new ProfileInfo(this, res.Persoon)
				this._privileges = new Privileges(this, res.Groep[0].Privileges)

				this._personUrl = `${baseUrl}/api/personen/${id}`
				this._pupilUrl = `${baseUrl}/api/leerlingen/${id}`

				return sessionId
			})
		})
	}
}

/**
 * Create a new Magister object using `options`.
 * @param {Object} options
 * 	@param {School} options.school The school to login to.
 * 	@param {String} [options.username] The username of the user to login to.
 * 	@param {String} [options.password] The password of the user to login to.
 * 	@param {String} [options.sessionId] The sessionId to use. (instead of the username and password)
 * 	@param {Boolean} [options.keepLoggedIn=true] Whether or not to keep the user logged in.
 * 	@param {Boolean} [options.login=true] Whether or not to call `Magister#login` before returning the object.
 * @return {Promise<Magister>}
 */
export default function magister (options) {
	_.defaults(options, {
		keepLoggedIn: true,
		login: true,
	})

	if (!
		(options.school &&
		(options.sessionId || (options.username && options.password)))
	) {
		return Promise.reject(new Error('school, username&password or sessionId are required.'))
	}

	const http = new Http()

	const m = new Magister(options, options.school, http)
	if (options.login) {
		return m.login().then(() => m)
	} else {
		return Promise.resolve(m)
	}
}

/**
 * Get the schools matching `query`.
 * @param {String} query
 * @return {Promise<School[]>}
 */
export function getSchools (query) {
	query = query.replace(/\d/g, '')
	query = query.trim()
	query = query.replace(/ +/g, '+')

	if (query.length < 3) {
		return Promise.resolve([])
	}

	return fetch(`https://mijn.magister.net/api/schools?filter=${query}`)
	.then(res => res.json())
	.then(schools => schools.map(school => new School(school)))
}

/**
 * The version of the library.
 * @type String
 * @readonly
 */
export const VERSION = __VERSION__
export {
	AbsenceInfo,
	AddressInfo,
	Appointment,
	AuthError,
	Course,
	Magister,
	Message,
	MessageFolder,
	Person,
	Privileges,
	ProfileInfo,
	ProfileSettings,
	School,
}